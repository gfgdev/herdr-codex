// Shared aggregate job-status projection. One implementation serves both the
// `get_job_status` MCP tool and the `agent status` CLI command so a manager can
// never get two different pictures of the same registered work.
//
// The projection reports FACTS per agent (assignment/task status, a bounded
// native observation with freshness, review/result state, unresolved request and
// message IDs, writer ownership) plus one conservative aggregate user state.
// A live, idle or finished process, an unaccepted report, or zero selected work
// are never treated as a completed job.
import { stateOf } from './attention.mjs';
import { assertNativeWorker } from './routing.mjs';
import { storedRetirement } from './retirement.mjs';

export const JOB_STATES = Object.freeze([
  'working', 'waiting_on_agents', 'reviewing', 'needs_you', 'done', 'unknown', 'failed', 'cancelled',
]);

// A recorded observation older than this is surfaced as stale and never used to
// claim live liveness or completion.
export const DEFAULT_STALE_MS = 120000;
const MAX_ITEMS = 20;
const MAX_PATHS = 8;
const clip = (value, max = 300) => typeof value === 'string' && value.length > max ? value.slice(0, max) + '…' : value;

// Most-actionable aggregate wins; `done` is only the top-level state when every
// selected agent is done.
const STATE_PRIORITY = ['failed', 'cancelled', 'needs_you', 'unknown', 'working', 'reviewing', 'waiting_on_agents', 'done'];
// A native status is only "settled" (safe to wait on the agent) when the turn
// parked in a normal idle/done state. Anything else - error, blocked, failed,
// cancelled, an unrecognised status - must never promise self-progress.
const SETTLED_STATUS = new Set(['idle', 'done']);

const isResult = m => m?.kind === 'result';
const isQuestion = m => m?.kind === 'question';
const isAttention = m => m?.kind === 'attention';
const actionOf = m => (m?.action?.kind ? m.action : null);

// A request is only "settled" once native input was accepted (`sent`) or its
// note was attached to a later turn. Everything else is still an obligation the
// projection must surface: `prepared`/`queued` were never injected, `sending`
// may have been, `uncertain`/`dispatching` cannot be confirmed. `failed` is a
// refused delivery that still needs reconciliation. None of these may be
// silently treated as done.
const OPEN_REQUEST_STATES = Object.freeze(['prepared', 'queued', 'sending', 'uncertain', 'dispatching']);

// Genuine, durable cancellation only. A review outcome of `abort` is a rejected
// report, NOT task cancellation, and must never mark the aggregate cancelled.
function taskCancellation(task, store) {
  if (task?.status === 'cancelled' || task?.cancelledAt) return true;
  const record = store.meta('cancel:' + task?.id);
  return Boolean(record && record.state === 'cancelled');
}

// Resolve the requested selection with the same exact-id / full-name rules as the
// other tools. Thread isolation comes from delegation.list({threadId}); a name
// shared by two agents is refused rather than silently picked.
export function selectAgents(delegation, threadId, target = null) {
  const summaries = delegation.list({ threadId });
  if (target == null) return summaries;
  const exact = summaries.filter(w => w.agentId === target);
  if (exact.length) return exact;
  const matches = summaries.filter(w => w.requestedName === target || w.name === target);
  if (!matches.length) throw new Error('Unknown agent');
  if (matches.length > 1) throw new Error(`Ambiguous agent name ${JSON.stringify(target)} matches ${matches.length} agents in this chat; pass the full agent_id`);
  return matches;
}

// One bounded native read per agent per status call: no polling loop, no model
// turn. A verified live snapshot is `fresh`; a failed read falls back to the last
// recorded bridge observation and labels its freshness. Anything else is Unknown.
async function observeNative({ store, delegation, worker, now, staleMs }) {
  const base = { state: 'unknown', lifecycle: null, turn: null, observed_at: now(), freshness: 'unavailable', source: 'none', identity: 'unavailable' };
  if (!worker.terminalId) return { ...base, note: 'No confirmed native terminal for this agent.' };
  const recorded = store.meta('observation:' + worker.id) ?? null;
  let native;
  try {
    native = await delegation.rpc.request('terminal.get', { terminal: worker.terminalId });
  } catch (error) {
    if (recorded?.observedAt) {
      const age = Date.parse(now()) - Date.parse(recorded.observedAt);
      const stale = !Number.isFinite(age) || age > staleMs;
      return {
        state: recorded.state ?? 'unknown', lifecycle: null, turn: Number.isSafeInteger(recorded.turn) ? recorded.turn : null,
        observed_at: recorded.observedAt, freshness: stale ? 'stale' : 'fresh', source: 'recorded', identity: 'unverified',
        note: clip(`Live native read failed (${error.message}); showing the last recorded observation.`),
      };
    }
    return { ...base, note: clip(`Native read failed: ${error.message}`) };
  }
  try {
    // allowFinished keeps deliberately stopped/finished history readable while
    // still rejecting a different process that reused the terminal address.
    assertNativeWorker(worker, native, { allowFinished: true });
  } catch (error) {
    return { ...base, source: 'live', identity: 'mismatch', note: clip(error.message) };
  }
  return {
    state: stateOf(native) ?? 'unknown', lifecycle: native.state ?? null, turn: Number.isSafeInteger(native.turn) ? native.turn : null,
    observed_at: now(), freshness: 'fresh', source: 'live', identity: 'verified',
  };
}

function classify(facts) {
  const { taskStatus, taskCancelled, quarantined, accepted, retired, writerOwned, pendingRetirement,
    pendingQuestions, pendingResults, pendingAttention, openObligations, refused, native } = facts;
  if (taskStatus === 'failed' || quarantined) {
    return { state: 'failed', next_actor: 'user', reason: quarantined ? 'Agent is quarantined after a recorded runtime fault.' : 'Task is registered as failed.' };
  }
  // Only a durable cancellation record cancels the job. A rejected (aborted)
  // report is a review outcome and stays separate.
  if (taskCancelled) return { state: 'cancelled', next_actor: null, reason: 'Task carries a durable cancellation record.' };
  // Routine reconciliation is the manager's job, not the user's. A native
  // identity mismatch, an unresolved delivery, an unacknowledged lifecycle
  // notice and accepted-but-not-yet-retired bookkeeping all surface as
  // `reviewing`/manager with a precise reason instead of escalating to `needs_you`.
  if (native.identity === 'mismatch') return { state: 'reviewing', next_actor: 'manager', reason: 'Native process identity no longer matches the registered agent; reconcile the original terminal before proceeding.' };
  if (openObligations.length) return { state: 'reviewing', next_actor: 'manager', reason: `Unresolved agent delivery (${openObligations.map(r => r.state).join(', ')}); reconcile or cancel each request before new input.` };
  if (refused.length) return { state: 'reviewing', next_actor: 'manager', reason: `Refused agent delivery (${refused.map(r => r.state).join(', ')}); reconcile before continuing.` };
  if (pendingQuestions.length) return { state: 'reviewing', next_actor: 'manager', reason: 'Agent question awaiting a manager reply; ordinary questions are a manager review, not automatic user escalation.' };
  if (pendingResults.length) return { state: 'reviewing', next_actor: 'manager', reason: 'Report pending review (accept or abort); acceptance alone does not close the task or stop the worker.' };
  // Every actionable pending kind blocks completion, including lifecycle/attention
  // notices (for example an unacknowledged intentional-stop notice). Known and
  // accepted reports do not silently cover them; the manager resolves them.
  if (pendingAttention.length) return { state: 'reviewing', next_actor: 'manager', reason: 'An unacknowledged lifecycle notice (for example a stop or runtime fault) remains; reconcile it before calling the job done.' };
  // `accepted` is the verdict on the LATEST result only, so an older accepted
  // report cannot satisfy done after a newer report was rejected or replied to.
  if (taskStatus === 'closed' && accepted && retired && !writerOwned) return { state: 'done', next_actor: null, reason: 'Latest report accepted, task closed and worker retired with no pending messages or writer ownership.' };
  if (taskStatus === 'closed' && accepted && !retired) {
    return native.state === 'working'
      ? { state: 'working', next_actor: 'agent', reason: 'Latest report accepted and task closed, but the worker process is still running.' }
      : { state: 'reviewing', next_actor: 'manager', reason: `Latest report accepted and task closed, but the worker is not retired${pendingRetirement ? ' (writer ownership is retained as pending_retirement)' : writerOwned ? ' (writer lease still held)' : ''}; reconcile the original exit and complete descendant clearance before finishing.` };
  }
  if (native.freshness !== 'fresh' || native.source !== 'live') {
    return { state: 'unknown', next_actor: 'manager', reason: `Native state ${native.freshness} (${native.source}); liveness cannot be confirmed on this call.` };
  }
  if (native.state === 'working') return { state: 'working', next_actor: 'agent', reason: 'Agent is executing its assigned turn.' };
  // A process exit or an incident/unknown native status (error, blocked, failed,
  // cancelled, or an unrecognised value) must never promise self-progress.
  if (native.lifecycle === 'finished' || !SETTLED_STATUS.has(native.state)) {
    if (accepted && taskStatus === 'active') return { state: 'reviewing', next_actor: 'manager', reason: 'Latest report accepted but the worker process is no longer running; retire it and close the task to finish.' };
    return { state: 'reviewing', next_actor: 'manager', reason: `Native status ${native.state}${native.lifecycle ? ` (${native.lifecycle})` : ''} does not promise further agent progress; inspect the terminal and decide the next step.` };
  }
  // An accepted report on a still-active assignment hands the move back to the
  // manager (retire the worker, close the task) rather than "waiting on agents".
  if (accepted && taskStatus === 'active') return { state: 'reviewing', next_actor: 'manager', reason: 'Latest report accepted and the agent is idle; retire the worker and close the task to finish.' };
  if (taskStatus === 'closed') return { state: 'reviewing', next_actor: 'manager', reason: 'Task is closed but the latest report was not accepted with a retired worker.' };
  return { state: 'waiting_on_agents', next_actor: 'agent', reason: 'Agent is idle or between turns with no report pending; waiting on the agent, not completed.' };
}

async function agentStatus({ store, delegation, summary, now, staleMs }) {
  const worker = store.worker(summary.agentId);
  const task = store.task(worker.taskId);
  const native = await observeNative({ store, delegation, worker, now, staleMs });
  const messages = store.messages({ taskId: worker.taskId }).filter(m => m.workerId === worker.id);
  const pending = messages.filter(m => !m.acknowledgedAt && m.kind !== 'progress');
  const pendingQuestions = pending.filter(isQuestion);
  const pendingResults = pending.filter(isResult);
  const pendingAttention = pending.filter(isAttention);
  // The current review verdict is decided by the LATEST result message only. A
  // historical acceptance must not outlive a newer rejection or reply.
  const latestResult = messages.filter(isResult).at(-1) ?? null;
  const latestVerdict = actionOf(latestResult)?.kind ?? null;
  const accepted = latestVerdict === 'accept' ? latestResult : null;
  const aborted = latestVerdict === 'abort' ? latestResult : null;
  const requests = delegation.requests.list(worker.id);
  const asFact = r => ({ request_id: r.requestId, kind: r.kind, state: r.state, delivery: r.delivery ?? null });
  const openObligations = requests.filter(r => OPEN_REQUEST_STATES.includes(r.state)).map(asFact);
  const refused = requests.filter(r => r.state === 'failed').map(asFact);
  const lease = store.writerLeases().find(l => l.workerId === worker.id) ?? null;
  const writerOwned = Boolean(lease);
  const retirementRecord = storedRetirement(store, worker.id);
  const pendingRetirement = retirementRecord?.state === 'pending_retirement';
  const quarantined = Boolean(store.meta('observation:' + worker.id)?.quarantined);
  const retired = !writerOwned && (['stopped', 'finished'].includes(worker.launchState) || (native.freshness === 'fresh' && native.source === 'live' && native.lifecycle === 'finished'));
  const verdict = classify({
    taskStatus: task.status, taskCancelled: taskCancellation(task, store), quarantined, accepted: Boolean(accepted), retired, writerOwned, pendingRetirement,
    pendingQuestions, pendingResults, pendingAttention, openObligations, refused, native,
  });
  return {
    agent_id: worker.id, task_id: worker.taskId, task_name: worker.requestedName ?? worker.name,
    task_status: task.status, state: verdict.state, next_actor: verdict.next_actor, reason: verdict.reason,
    native,
    assignment: {
      launch_state: worker.launchState ?? null, scope: worker.writePaths?.length ? 'write' : 'read-only',
      harness: worker.role ?? null, template: worker.delegation?.spec?.template?.name ?? null,
      execution_kind: worker.executionKind ?? 'session', parent_id: worker.delegation?.spec?.parentId ?? worker.adoption?.spec?.parentId ?? null,
      supervisor_id: worker.supervisorId ?? null, workspace: worker.delegation?.spec?.deskWorkspace ?? null,
      context_hash: worker.delegation?.spec?.context?.sha256 ?? null,
    },
    review: {
      accepted: Boolean(accepted), accepted_message_id: accepted?.id ?? null, accepted_at: accepted?.action?.at ?? null,
      aborted: Boolean(aborted), aborted_message_id: aborted?.id ?? null,
      pending: pending.map(m => ({ message_id: m.id, kind: m.kind, created_at: m.createdAt ?? null })).slice(0, MAX_ITEMS),
      pending_count: pending.length,
    },
    requests: {
      unresolved: openObligations.slice(0, MAX_ITEMS), unresolved_count: openObligations.length,
      refused: refused.slice(0, MAX_ITEMS), refused_count: refused.length,
      total: requests.length,
    },
    messages: { pending_ids: pending.map(m => m.id).slice(0, MAX_ITEMS), pending_count: pending.length },
    ownership: { writer: writerOwned, paths: (lease?.paths ?? []).slice(0, MAX_PATHS).map(p => clip(p, 400)), path_count: lease?.paths?.length ?? 0 },
    retirement: { state: retirementRecord?.state ?? null, execution_id: retirementRecord?.executionId ?? null, reason: retirementRecord?.reason ?? null },
  };
}

/**
 * Project the aggregate job status for one exact manager chat (and optional
 * target). Pure read: at most one bounded native read per selected agent.
 */
export async function projectJobStatus({ store, delegation, threadId, target = null, now = () => new Date().toISOString(), staleMs = DEFAULT_STALE_MS }) {
  if (typeof threadId !== 'string' || !threadId) throw new Error('thread_id is required');
  const summaries = selectAgents(delegation, threadId, target);
  const observedAt = now();
  const agents = [];
  for (const summary of summaries) agents.push(await agentStatus({ store, delegation, summary, now, staleMs }));
  const counts = Object.fromEntries(JOB_STATES.map(s => [s, agents.filter(a => a.state === s).length]));
  // Terminal-only states (`done`, `cancelled`) describe the whole selection only
  // when nothing in the selection still has an actionable next actor. A mixed
  // selection keeps the most-actionable non-terminal state so it never hides
  // still-live or still-owned work behind a terminal label.
  const actionable = agents.filter(a => a.next_actor !== null);
  const pool = actionable.length ? actionable : agents;
  let winner = null;
  for (const candidate of STATE_PRIORITY) { const hit = pool.find(a => a.state === candidate); if (hit) { winner = hit; break; } }
  const state = winner?.state ?? null;
  const reason = !agents.length
    ? 'No agents are registered for this selection; zero selected work is not completed work.'
    : `${counts[state]} of ${agents.length} agent(s) ${state}: ${winner.reason}`;
  return {
    thread_id: threadId,
    job: {
      // The aggregate actor is the winning agent's own verdict, so mixed actors
      // for one state are never collapsed onto a static lookup table.
      state: state ?? 'unknown', next_actor: winner ? winner.next_actor : 'user', reason,
      counts, agent_count: agents.length, observed_at: observedAt, stale_after_ms: staleMs,
      done_requires: 'accepted report + closed task + retired worker + no unresolved messages or writer ownership',
    },
    selection: { target: target ?? null, agent_count: agents.length },
    agents,
  };
}

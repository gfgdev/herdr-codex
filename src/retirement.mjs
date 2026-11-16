import { digest } from './config.mjs';

const now = () => new Date().toISOString();
const decode = row => row ? JSON.parse(row.data) : null;
const MANAGER_CHAT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_REFERENCE = 256;
// A `complete` containment verdict must enumerate a BOUNDED descendant set.
const MAX_DESCENDANTS = 4096;

// Descendant-clearance coverage. Production Herdr has NO qualified exhaustive
// OS containment, so the honest default is `unknown`. A caller (test or a future
// qualified containment provider) may pass explicit evidence; the service never
// fabricates live clearance from a native idle/done/closed/missing observation.
export const COVERAGE = Object.freeze({ COMPLETE: 'complete', PARTIAL: 'partial', UNKNOWN: 'unknown' });
export const RETIREMENT = Object.freeze({ PENDING: 'pending_retirement', RELEASED: 'released' });

// Conservative default evidence provider: it reports only what this layer can
// actually prove, which is nothing about OS descendants. It must never claim
// `complete`, and it never invents a bound execution identity.
export const noCoverage = ({ executionId = null } = {}) => ({
  coverage: COVERAGE.UNKNOWN,
  executionId,
  source: 'default-no-os-containment',
  observedAt: now(),
  descendants: [],
});
// The provider's identity IS its provenance: only a containment provider whose
// source was declared at construction is trusted to assert `complete`. A bare
// `source` string chosen by a caller is never proof of qualification.
noCoverage.source = 'default-no-os-containment';

// Delegation and adoption persist the explicit parent link inside their frozen
// spec; `supervisorId` is a top-level worker field. Resolve the recorded parent
// without inventing a value the store never wrote.
export function parentOf(worker) {
  if (!worker) return null;
  return worker.delegation?.spec?.parentId ?? worker.adoption?.spec?.parentId ?? worker.parentId ?? null;
}

/**
 * A versioned, immutable execution binding built ONLY from fields that were
 * actually recorded at launch/adoption. `launch.json` carries `pid` and
 * `terminalId`, not a creation token, so no creation identity is invented here.
 */
export function executionBinding(worker) {
  if (!worker) return null;
  return {
    version: 1,
    workerId: worker.id,
    taskId: worker.taskId,
    terminalId: worker.terminalId ?? null,
    pid: worker.launchResult?.pid ?? null,
    createdMs: worker.launchIdentity?.created_ms ?? null,
    parentId: parentOf(worker),
    supervisorId: worker.supervisorId ?? null,
    adopted: worker.adopted === true,
    executionKind: worker.executionKind ?? 'native',
  };
}

export const bindingEquals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Accepted explicit quiescent descendant states. These assert a terminal OS
// process; idle/done/closed/running observations are turn state and are NOT exit
// proof, so they are deliberately absent here and classify as `unknown`.
const TERMINAL_DESCENDANT_STATES = new Set(['exited', 'dead', 'stopped', 'finished', 'terminated', 'reaped', 'gone']);
const LIVE_DESCENDANT_STATES = new Set(['live', 'running', 'active', 'alive']);

/**
 * Classify ONE provider-reported OS descendant entry. Accepted explicit
 * quiescent shape (must name the process AND assert a terminal state):
 *   { pid: <finite number|non-empty string> | id: <string|finite number>,
 *     exited: true | stopped: true | quiescent: true }
 *   or state/status in { exited, dead, stopped, finished, terminated, reaped, gone }.
 * Anything else is conservative: a missing/malformed identity is `malformed`,
 * contradictory live+terminal indicators are `contradictory`, an explicit
 * live/alive/running marker is `live`, and an absent or unrecognised state is
 * `unknown`. Absence of a live flag is NEVER taken as proof of exit.
 */
function classifyDescendant(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'malformed';
  const { pid, id } = entry;
  const named = (typeof pid === 'number' && Number.isFinite(pid)) || (typeof pid === 'string' && pid.trim())
    || (typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id));
  if (!named) return 'malformed';
  const tokens = [entry.state, entry.status]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim().toLowerCase());
  const hasLive = entry.live === true || entry.alive === true || entry.running === true
    || tokens.some(token => LIVE_DESCENDANT_STATES.has(token));
  const hasTerminal = entry.exited === true || entry.stopped === true || entry.quiescent === true
    || tokens.some(token => TERMINAL_DESCENDANT_STATES.has(token));
  if (hasLive && hasTerminal) return 'contradictory';
  if (hasLive) return 'live';
  if (hasTerminal) return 'quiescent';
  return 'unknown';
}

// Bucket a provider verdict's descendant evidence. A missing or oversized array
// is never well-formed, so a `complete` label over it degrades to `unknown`.
function descendantReport(raw) {
  const buckets = { entries: [], live: [], unknown: [], malformed: [], contradictory: [], quiescent: [] };
  if (raw === undefined || raw === null || !Array.isArray(raw) || raw.length > MAX_DESCENDANTS)
    return { wellFormed: false, ...buckets };
  const report = { wellFormed: true, entries: raw, live: [], unknown: [], malformed: [], contradictory: [], quiescent: [] };
  for (const entry of raw) report[classifyDescendant(entry)].push(entry);
  report.wellFormed = report.malformed.length === 0;
  return report;
}

/**
 * Read-only accessor for a stored retirement record. Tolerates a database that
 * predates the `retirements` table (a pure status projection must not create
 * tables or throw), returning `null` when no record/table exists.
 */
export function storedRetirement(store, workerId) {
  try {
    return decode(store.db.prepare('SELECT data FROM retirements WHERE worker_id=?').get(workerId));
  } catch {
    return null;
  }
}

/**
 * Shared durable retirement/ownership service.
 *
 * Native exit/stop attribution, descendant clearance, result acceptance and
 * writer ownership are deliberately SEPARATE facts. A verified original-process
 * exit may mark a worker stopped, but the writer lease is retained as
 * `pending_retirement` until descendant clearance is explicitly complete.
 * Every release of writer ownership must funnel through `settle`, so no caller
 * can drop ownership on parent-terminal-only evidence.
 */
export class Retirement {
  constructor(store, { provider = noCoverage, trustedSources = null } = {}) {
    this.store = store;
    this.provider = provider;
    // Trusted containment-provenance allowlist. Injection at construction is the
    // authority; a caller cannot mint trust by writing a `source` field into
    // evidence it supplies later.
    this.trustedSources = new Set((trustedSources ?? [provider?.source]).filter(s => typeof s === 'string' && s.length));
    store.db.exec(`CREATE TABLE IF NOT EXISTS retirements(
      worker_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, state TEXT NOT NULL,
      data TEXT NOT NULL, at TEXT NOT NULL);`);
  }

  record(workerId) { return decode(this.store.db.prepare('SELECT data FROM retirements WHERE worker_id=?').get(workerId)); }
  executionId(worker) { return digest(JSON.stringify(executionBinding(worker))); }

  /**
   * Registered descendant graph. Covers the explicit `parentId` (via the frozen
   * delegation/adoption spec) and `supervisorId` links that Herdr actually
   * persists. Cycles and cross-chat mismatches are surfaced as issues, never
   * silently ignored. A child `closed` flag is NOT exit or lease-clearance
   * proof; this graph only tells us which bindings exist, not whether their OS
   * processes are gone.
   */
  graph(worker) {
    const task = worker ? this.store.task(worker.taskId) : null;
    const found = new Map();
    const visiting = new Set();
    const done = new Set();
    const issues = [];
    const childrenOf = parent => this.store.workers().filter(w => w.id !== parent.id
      && (parentOf(w) === parent.id || w.supervisorId === parent.id));
    const visit = parent => {
      if (visiting.has(parent.id)) { issues.push({ workerId: parent.id, issue: 'cycle' }); return; }
      if (done.has(parent.id)) return;
      visiting.add(parent.id);
      for (const child of childrenOf(parent)) {
        const childTask = this.store.task(child.taskId);
        if (!childTask || !task || childTask.threadId !== task.threadId || child.project !== worker.project) {
          issues.push({ workerId: child.id, taskId: child.taskId, issue: 'cross-chat' });
          found.set(child.id, child);
          continue;
        }
        found.set(child.id, child);
        visit(child);
      }
      visiting.delete(parent.id);
      done.add(parent.id);
    };
    if (worker) visit(worker);
    return { descendants: [...found.values()], issues };
  }

  /**
   * Local, conservative proof that a registered descendant is no longer a live
   * process. Idle/done/closed observations are turn state, NOT exit proof, so
   * only an explicit stopped observation or a recorded terminal launch state
   * clears a child. Anything else counts as live/unknown and blocks complete
   * clearance -- absence of evidence is never clearance.
   */
  descendantExited(worker) {
    if (!worker) return true;
    // A still-held writer lease is ownership proof that the child has not been
    // retired: it blocks clearance regardless of any observation, because the
    // lease is released only by the shared settle path.
    if (this.store.writerLeases().some(lease => lease.workerId === worker.id)) return false;
    if (this.store.meta(`observation:${worker.id}`)?.stopped === true) return true;
    return worker.launchState === 'finished' || worker.launchState === 'stopped';
  }

  /**
   * Evaluate descendant clearance. The trusted provider/verifier is the SOLE
   * authority on OS descendant clearance: it is always consulted for the exact
   * immutable execution, and it receives any caller-supplied `claim` only as an
   * unverified hint. The service NEVER reads `coverage`/`source` off caller
   * evidence directly, so copying a trusted (or default) source label mints
   * nothing. A provider `complete` counts only when its source is trusted AND it
   * is bound to THIS exact execution; a provider that returns unknown, partial,
   * an error, a mismatched execution, or explicit live/unknown OS descendants
   * is held. A `complete` verdict must ALSO enumerate a well-formed, bounded
   * descendant array whose every entry explicitly asserts a terminal state (see
   * `classifyDescendant`); a missing, malformed, oversized, contradictory or
   * state-less entry is not exit proof and is held. A provider that throws is
   * caught and treated as an unknown/error hold, so the caller's exit
   * transaction is preserved rather than lost to an escaped exception. The
   * registered graph is rechecked independently.
   */
  clearance(worker, claim) {
    const graph = this.graph(worker);
    const executionId = this.executionId(worker);
    // A throwing provider is a containment fault, not clearance. Catch it here so
    // the caller's exit transaction is never lost to an escaped exception: the
    // verdict becomes an honest unknown/error hold.
    let verdict;
    try {
      verdict = this.provider({ worker, graph, executionId, claim: claim ?? null });
    } catch (error) {
      verdict = { coverage: COVERAGE.UNKNOWN, source: null, executionId: null, error: error?.message ?? String(error), descendants: null };
    }
    verdict = verdict ?? {};
    const claimed = verdict.coverage ?? COVERAGE.UNKNOWN;
    const sourceTrusted = typeof verdict.source === 'string' && this.trustedSources.has(verdict.source);
    const errored = verdict.error != null;
    // A `complete` verdict must enumerate a WELL-FORMED, bounded descendant
    // array in which every entry explicitly asserts a terminal state. Missing,
    // malformed, oversized, contradictory or state-less entries are not exit
    // proof, so a `complete` label over them is downgraded to `unknown`.
    const report = descendantReport(verdict.descendants);
    const evidenceOk = report.wellFormed && report.live.length === 0
      && report.contradictory.length === 0 && report.unknown.length === 0;
    // `complete` counts only when the VERDICT is trusted, error-free, bound to
    // this exact execution, and backed by well-formed quiescent descendant
    // evidence. Anything else is downgraded to `unknown`.
    const bound = claimed === COVERAGE.COMPLETE && verdict.executionId === executionId
      && sourceTrusted && !errored && evidenceOk;
    const coverage = (claimed === COVERAGE.COMPLETE && !bound) || errored ? COVERAGE.UNKNOWN : claimed;
    // Independently recheck the registered graph: a complete verdict that
    // ignores still-live registered children is refused.
    const liveChildren = graph.descendants.filter(w => !this.descendantExited(w));
    const complete = coverage === COVERAGE.COMPLETE && graph.issues.length === 0 && liveChildren.length === 0;
    const reason = complete ? null
      : graph.issues.length ? 'registered-child-graph-unsafe'
      : liveChildren.length ? 'registered-child-live'
      : errored ? 'descendant-coverage-error'
      : claimed === COVERAGE.COMPLETE && !sourceTrusted ? 'clearance-evidence-untrusted'
      : claimed === COVERAGE.COMPLETE && verdict.executionId !== executionId ? 'clearance-evidence-unbound'
      : claimed === COVERAGE.COMPLETE && report.live.length ? 'descendant-live-evidence'
      : claimed === COVERAGE.COMPLETE && report.contradictory.length ? 'descendant-evidence-contradictory'
      : claimed === COVERAGE.COMPLETE && (!report.wellFormed || report.malformed.length) ? 'descendant-evidence-malformed'
      : claimed === COVERAGE.COMPLETE && report.unknown.length ? 'descendant-evidence-unknown'
      : coverage === COVERAGE.UNKNOWN ? 'descendant-coverage-unknown'
      : coverage === COVERAGE.PARTIAL ? 'descendant-coverage-partial'
      : 'descendant-clearance-not-complete';
    return {
      coverage,
      claimed,
      bound,
      executionId,
      source: verdict.source ?? null,
      observedAt: verdict.observedAt ?? now(),
      descendants: report.entries,
      liveEvidence: report.live.map(d => d?.pid ?? d?.id ?? null),
      descendantEvidence: { wellFormed: report.wellFormed, live: report.live.length, unknown: report.unknown.length, malformed: report.malformed.length, contradictory: report.contradictory.length },
      graph: graph.descendants.map(w => ({ workerId: w.id, taskId: w.taskId, status: this.store.task(w.taskId)?.status ?? null })),
      liveChildren: liveChildren.map(w => w.id),
      graphIssues: graph.issues,
      complete,
      reason,
    };
  }

  /**
   * Record explicit, manager-supplied complete clearance bound to the exact
   * execution identity. Never fabricates `complete`: the supplied evidence must
   * itself be complete, bound to the current execution, and survive the
   * registered-graph recheck.
   */
  setClearance(worker, evidence, { source = null, at = now() } = {}) {
    const authority = source ?? evidence?.source ?? null;
    const reference = evidence?.reference ?? null;
    if (typeof authority !== 'string' || !authority.trim()) throw new Error('Clearance evidence requires an authority');
    if (!this.trustedSources.has(authority)) throw new Error('Clearance evidence source is not a trusted containment provider');
    if (typeof reference !== 'string' || !reference.trim() || reference.length > MAX_REFERENCE)
      throw new Error('Clearance evidence requires a bounded reference');
    // The provider/verifier is the sole authority; the caller's coverage/source
    // are an unverified CLAIM passed through, never trusted directly. A caller
    // that copies the authority string still cannot mint `complete` unless the
    // provider independently returns a trusted, execution-bound verdict.
    const judgement = this.clearance(worker, {
      coverage: evidence?.coverage ?? COVERAGE.UNKNOWN,
      executionId: evidence?.executionId ?? null,
      source: authority,
      reference,
      observedAt: at,
      descendants: Array.isArray(evidence?.descendants) ? evidence.descendants : [],
    });
    if (!judgement.complete) throw new Error('Clearance evidence is not complete for this exact execution: ' + judgement.reason);
    const record = { workerId: worker.id, executionId: judgement.executionId, coverage: COVERAGE.COMPLETE,
      source: judgement.source, observedAt: at, reference, descendants: judgement.descendants };
    this.store.meta(`clearance:${worker.id}`, record);
    this.store.journal('retirement.clearance', { workerId: worker.id, taskId: worker.taskId, executionId: record.executionId, source: record.source, reference });
    return record;
  }

  storedClearance(worker) {
    const record = this.store.meta(`clearance:${worker.id}`);
    if (!record || record.executionId !== this.executionId(worker)) return null;
    return record;
  }

  /**
   * Begin explicit retirement: freeze new followups through the existing stop
   * barrier and durably record the pending ownership transition. Idempotent and
   * conflict-guarded: a repeat carries the same immutable request/execution
   * binding, and a conflicting request ID is refused rather than overwriting.
   */
  request(worker, { requestId = null, reason = 'explicit-retirement' } = {}) {
    if (!worker) throw new Error('Retirement requires a registered worker');
    const prior = this.record(worker.id) ?? {};
    // Conflicts are validated BEFORE any released short-circuit, so a replay
    // can never smuggle in a different request or execution identity.
    if (requestId && prior.requestId && prior.requestId !== requestId)
      throw new Error('Retirement is already bound to request ' + prior.requestId);
    const executionId = this.executionId(worker);
    if (prior.executionId && prior.executionId !== executionId) {
      if (prior.state === RETIREMENT.RELEASED)
        throw new Error('Execution binding changed after release; a new execution requires a new retirement');
      return this.hold(worker, { reason: 'execution-binding-changed', requestId, judgement: prior.clearance ?? null }).record;
    }
    if (prior.state === RETIREMENT.RELEASED) return prior;
    const stop = this.store.meta('stop:' + worker.id) ?? {};
    // The existing request ordering already refuses ordinary input once the stop
    // barrier is present, so retirement reuses it rather than inventing a second
    // freeze mechanism.
    if (!this.store.meta('stop:' + worker.id))
      this.store.meta('stop:' + worker.id, { ...stop, requestId: stop.requestId ?? requestId ?? null, state: stop.state ?? 'unconfirmed' });
    const conflict = requestId && stop.requestId && stop.requestId !== requestId;
    if (conflict) throw new Error('Stop barrier is already bound to request ' + stop.requestId);
    const record = { ...prior, workerId: worker.id, executionId, binding: prior.binding ?? executionBinding(worker),
      state: RETIREMENT.PENDING, requestId: prior.requestId ?? requestId ?? null, reason: prior.reason ?? reason,
      pendingAt: prior.pendingAt ?? now(), checkedAt: now() };
    this.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET execution_id=excluded.execution_id,state=excluded.state,data=excluded.data,at=excluded.at')
      .run(worker.id, executionId, RETIREMENT.PENDING, JSON.stringify(record), record.checkedAt);
    if (prior.state !== RETIREMENT.PENDING) this.store.journal('retirement.pending', { workerId: worker.id, taskId: worker.taskId, requestId: record.requestId, reason: record.reason });
    return record;
  }

  /**
   * Retain ownership with an exact reason; never releases. A prior execution
   * binding is immutable: after a mismatch the ORIGINAL binding is preserved and
   * the newly observed binding is recorded separately, so a replaced process can
   * never rewrite the identity the lease was granted for.
   */
  hold(worker, { reason, judgement = null, requestId = null } = {}) {
    const prior = this.record(worker.id) ?? {};
    if (prior.state === RETIREMENT.RELEASED) return { released: false, state: RETIREMENT.RELEASED, reason: 'already-released', record: prior };
    if (requestId && prior.requestId && prior.requestId !== requestId)
      throw new Error('Retirement is already bound to request ' + prior.requestId);
    const current = executionBinding(worker);
    const binding = prior.binding ?? current;
    const mismatch = prior.binding && !bindingEquals(prior.binding, current)
      ? { expected: prior.binding, observed: current, at: now() }
      : (prior.bindingMismatch ?? null);
    const record = { ...prior, workerId: worker.id, executionId: prior.executionId ?? this.executionId(worker), binding,
      state: RETIREMENT.PENDING, requestId: prior.requestId ?? requestId ?? null, reason,
      clearance: judgement ?? prior.clearance ?? null, pendingAt: prior.pendingAt ?? now(), checkedAt: now(),
      ...(mismatch ? { bindingMismatch: mismatch } : {}) };
    this.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET execution_id=excluded.execution_id,state=excluded.state,data=excluded.data,at=excluded.at')
      .run(worker.id, record.executionId, record.state, JSON.stringify(record), record.checkedAt);
    if (prior.state !== RETIREMENT.PENDING) this.store.journal('retirement.pending', { workerId: worker.id, taskId: worker.taskId, requestId: record.requestId, reason });
    return { released: false, state: RETIREMENT.PENDING, reason, record };
  }

  /**
   * The single guarded release point. Releases writer ownership only when the
   * ORIGINAL process exit is verified AND descendant clearance is complete.
   * Otherwise the lease is retained as `pending_retirement`. Release + optional
   * task close + retirement record compose in one transaction, so a fault rolls
   * back ownership rather than half-settling. An already-released retirement is
   * a no-op: it is never re-released, never re-journaled and never re-closed. A
   * late `closeTask` for a task the release left open is an explicit refusal
   * (error code `retirement-released-without-close`, no mutation); a replay
   * against a task the release already closed stays idempotent.
   */
  settle({ worker, requestId = null, attribution = null, observedExit = null, evidence = null, closeTask = false, reason = null } = {}) {
    if (!worker) return { released: false, state: RETIREMENT.PENDING, reason: 'unknown-worker' };
    const prior = this.record(worker.id);
    // Conflicts are validated BEFORE the idempotent released short-circuit: an
    // already-released retirement still refuses a different request ID or a
    // changed execution binding instead of silently returning the old record.
    if (requestId && prior?.requestId && prior.requestId !== requestId)
      throw new Error('Retirement is already bound to request ' + prior.requestId);
    if (prior?.executionId && prior.executionId !== this.executionId(worker)) {
      if (prior.state === RETIREMENT.RELEASED)
        throw new Error('Execution binding changed after release; a new execution requires a new retirement');
      return this.hold(worker, { reason: 'execution-binding-changed', requestId, judgement: prior.clearance ?? null });
    }
    if (prior?.state === RETIREMENT.RELEASED) {
      // A released retirement is an idempotent no-op EXCEPT for a late request
      // to close a task the release left open. Silently reporting success would
      // falsely imply the task was closed, and re-releasing or re-journaling
      // would corrupt ownership, so an unfulfilled close is an explicit refusal
      // with no mutation. A task the release already closed (or one that no
      // longer exists) makes the replay genuine and idempotent.
      if (closeTask) {
        const task = this.store.task(worker.taskId);
        if (task && task.status !== 'closed') {
          const error = new Error('Retirement is already released without closing task ' + task.id
            + '; close the task explicitly instead of re-settling it');
          error.code = 'retirement-released-without-close';
          throw error;
        }
      }
      return { released: true, state: RETIREMENT.RELEASED, idempotent: true, record: prior };
    }
    // Read-only / no-writer workers have no ownership to retain: there is no
    // lease for descendant clearance to gate, so they are an explicit,
    // non-holding case. A verified never-launched rollback (local preparation
    // failed before ANY native request) is released the same way: there is no
    // original process and therefore no descendant graph to clear. It is
    // strictly gated on the exact rollback launch state AND the absence of a
    // terminal, so a worker that ever reached native can never be released
    // through this branch. These are the ONLY releases that do not require a
    // verified exit + complete clearance, and both are safe because nothing was
    // ever launched.
    const neverLaunched = !worker.terminalId && worker.launchState === 'preparation_failed';
    if (neverLaunched || !this.store.writerLeases().some(lease => lease.workerId === worker.id)) {
      // Nothing was ever launched, so there is no OS process/descendant graph to
      // clear -- but any reservation that was still taken must be freed. The
      // writer-lease release, optional task close, released record and journal
      // entry compose in ONE transaction, so a fault rolls the reservation back
      // instead of leaking ownership while reporting a release. This branch is
      // reached ONLY for a proven never-launched rollback (exact launch state
      // AND no terminal) or a worker that never held a lease at all; an unknown
      // launch state falls through to the normal hold path below.
      return this.store.transaction(() => {
        this.store.releaseWriter(worker.id);
        if (closeTask) {
          const task = this.store.task(worker.taskId);
          if (task && task.status !== 'closed') this.store.saveTask({ ...task, status: 'closed', closedAt: now() });
        }
        const record = { ...prior, workerId: worker.id, executionId: this.executionId(worker), binding: executionBinding(worker),
          state: RETIREMENT.RELEASED, requestId: requestId ?? prior?.requestId ?? null,
          reason: reason ?? (neverLaunched ? 'never-launched' : 'no-writer-ownership'), attribution: attribution ?? prior?.attribution ?? null,
          observedExit: observedExit ?? prior?.observedExit ?? null, releasedAt: now() };
        this.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET execution_id=excluded.execution_id,state=excluded.state,data=excluded.data,at=excluded.at')
          .run(worker.id, record.executionId, record.state, JSON.stringify(record), record.releasedAt);
        this.store.journal('retirement.released', { workerId: worker.id, taskId: worker.taskId, requestId: record.requestId, reason: record.reason });
        return { released: true, state: RETIREMENT.RELEASED, record };
      });
    }
    if (observedExit?.confirmed !== true) {
      const judgement = this.clearance(worker, evidence ?? null);
      return this.hold(worker, { reason: 'original-exit-unverified', judgement, requestId });
    }
    // The provider/verifier is consulted for the exact execution; caller
    // evidence is only an unverified hint and can never mint authority.
    const claim = evidence ?? this.storedClearance(worker) ?? null;
    const judgement = this.clearance(worker, claim);
    if (!judgement.complete) return this.hold(worker, { reason: judgement.reason, judgement, requestId });
    return this.store.transaction(() => {
      this.store.releaseWriter(worker.id);
      if (closeTask) {
        const task = this.store.task(worker.taskId);
        if (task && task.status !== 'closed') this.store.saveTask({ ...task, status: 'closed', closedAt: now() });
      }
      const record = { ...prior, workerId: worker.id, executionId: this.executionId(worker), binding: executionBinding(worker),
        state: RETIREMENT.RELEASED, requestId: requestId ?? prior?.requestId ?? null,
        reason: reason ?? 'clearance-complete', attribution: attribution ?? prior?.attribution ?? null,
        observedExit: observedExit ?? prior?.observedExit ?? null, clearance: judgement, releasedAt: now() };
      this.store.db.prepare('INSERT INTO retirements VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET execution_id=excluded.execution_id,state=excluded.state,data=excluded.data,at=excluded.at')
        .run(worker.id, record.executionId, record.state, JSON.stringify(record), record.releasedAt);
      this.store.journal('retirement.released', { workerId: worker.id, taskId: worker.taskId, requestId: record.requestId, reason: record.reason });
      return { released: true, state: RETIREMENT.RELEASED, record };
    });
  }

  /**
   * Bounded manager reconciliation. Requires the exact chat, the exact current
   * execution identity and explicit complete clearance evidence with a
   * reference/authority. No generic force switch: missing, stale or
   * worker-authored evidence fails closed. The clearance itself is re-validated
   * against the registered graph (including live children), and the final
   * release + task close transition is atomic (see `settle`).
   */
  reconcile({ threadId, workerId, executionId, requestId = null, evidence, closeTask = false } = {}) {
    if (!MANAGER_CHAT.test(threadId ?? '')) throw new Error('Reconciliation requires the exact manager chat UUID');
    const worker = this.store.worker(workerId);
    if (!worker) throw new Error('Unknown worker');
    const task = this.store.task(worker.taskId);
    if (!task || task.threadId !== threadId) throw new Error('Worker does not belong to this chat');
    const current = this.executionId(worker);
    if (!executionId || executionId !== current) throw new Error('Execution identity does not match the current binding');
    if (evidence?.executionId && evidence.executionId !== current) throw new Error('Clearance evidence is bound to a different execution');
    if (!evidence || evidence.coverage !== COVERAGE.COMPLETE || !Array.isArray(evidence.descendants))
      throw new Error('Reconciliation requires explicit complete descendant-clearance evidence; unknown coverage is refused');
    const stop = this.store.meta('stop:' + worker.id) ?? {};
    if (!stop.observedExit?.reason) throw new Error('The original process exit is not durably verified; reconcile the stop first');
    // `setClearance` re-runs the graph/liveness recheck and refuses any
    // incomplete or unbound claim; this is not a text-trusting store.
    const bound = { ...evidence, executionId: current };
    this.setClearance(worker, bound, { source: evidence.source, at: evidence.at });
    return this.settle({ worker, requestId: requestId ?? stop.requestId ?? null, attribution: stop.attribution ?? null,
      observedExit: { ...stop.observedExit, confirmed: true }, evidence: bound, closeTask, reason: 'manager-reconciled' });
  }

  status(workerId) { return this.record(workerId); }
}

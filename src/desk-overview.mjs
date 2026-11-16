import {Desks} from './desks.mjs';
import {storedRetirement} from './retirement.mjs';
import {uuid} from './config.mjs';

// Compact, read-only projection of EXISTING stored records for one desk.
//
// This module performs NO native calls and mutates nothing. Every value is a
// recorded integration fact: registered desk/project/agent/task/role rows, the
// recorded launch/lifecycle state, the durable retirement record and the actual
// writer-lease table. It deliberately distinguishes those recorded facts from
// live verification, which it never performs.
//
// Lists are bounded and always report `total` + `truncated` so a caller can see
// when output was clipped rather than silently receiving a partial view. Report
// bodies, message text, prompts and history are never included.

export const OVERVIEW_LIMIT = 25;
const MAX_LIMIT = 200;

// Request states that are not yet terminal. `attached` is a queued note folded
// into a claim; `sending`/`uncertain` are in-flight claims. Terminal states are
// sent, failed, delivered and cancelled.
const OPEN_REQUEST_STATES = new Set(['prepared', 'queued', 'sending', 'uncertain', 'attached']);

// Every durable request state this integration writes. Kept explicit so an
// unrecognised state is surfaced as unknown rather than silently treated as
// closed (which would hide a blocking request).
const REQUEST_STATES = new Set([...OPEN_REQUEST_STATES, 'sent', 'failed', 'delivered', 'cancelled']);

const now = () => new Date().toISOString();

// Path comparison mirrors the Store writer-lease rule (case-folded on darwin,
// NFC-normalized) without touching the filesystem.
const pathKey = value => {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.normalize('NFC').replace(/\/+$/, '') || '/';
  return process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
};
const pathOverlap = (a, b) => {
  a = pathKey(a);
  b = pathKey(b);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
};

// Whether this database has the durable request table at all. A legacy
// command-only database genuinely predates `agent_requests`; that exact
// supported schema state means "no durable requests", and nothing else is
// inferred from it. Mirrors the existing convention in desk-runs.mjs.
function requestTablePresent(store) {
  const row = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_requests'").get();
  return Boolean(row);
}

// Validate one stored request record enough to CLASSIFY it, without echoing any
// of its content. `rowRequestId` is the identity column the row was read under,
// so a record whose payload disagrees with its own row is rejected too. Returns
// a stable reason code, or null when the record is well-formed and classifiable.
function requestRecordIssue(record, workerId, rowRequestId) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'not-an-object';
  if (typeof record.workerId !== 'string' || !record.workerId) return 'missing-worker-id';
  if (record.workerId !== workerId) return 'worker-mismatch';
  if (typeof record.requestId !== 'string' || !record.requestId) return 'missing-request-id';
  if (rowRequestId !== undefined && record.requestId !== rowRequestId) return 'row-mismatch';
  if (typeof record.state !== 'string' || !record.state) return 'missing-state';
  if (!REQUEST_STATES.has(record.state)) return 'unknown-state';
  return null;
}

// Read the durable outbound-request rows for one worker. Only a genuinely
// absent `agent_requests` table may be reported as empty. A query failure, a
// malformed record, or a record that cannot be classified (or whose identity
// disagrees with the row it was read under) is reported as a stable
// `{workerId,row,reason}` issue and NEVER downgraded to "zero pending". Issue
// text never includes record content, so it cannot echo untrusted input.
function readRequests(store, workerId) {
  let rows;
  try {
    if (!requestTablePresent(store)) return {ok: true, records: [], issues: []};
    rows = store.db.prepare('SELECT request_id, data FROM agent_requests WHERE worker_id=? ORDER BY rowid').all(workerId);
  } catch {
    return {ok: false, records: [], issues: [{workerId, row: null, reason: 'read-failed'}]};
  }
  const records = [];
  const issues = [];
  for (const [index, row] of rows.entries()) {
    let record;
    try {
      record = JSON.parse(row.data);
    } catch {
      issues.push({workerId, row: index + 1, reason: 'malformed-json'});
      continue;
    }
    const reason = requestRecordIssue(record, workerId, row.request_id);
    if (reason) issues.push({workerId, row: index + 1, reason});
    else records.push(record);
  }
  return {ok: issues.length === 0, records, issues};
}

function bounded(items, limit) {
  return {total: items.length, truncated: items.length > limit, items: items.slice(0, limit)};
}

/**
 * Build the compact overview. `threadId`, when supplied, narrows the AGENT
 * projection to one owner chat; writer reservations are NEVER hidden by it,
 * because another owner's blocking checkout reservation is the fact a manager
 * most needs before assigning work.
 */
export function deskOverview({store, config, deskId, threadId = null, limit = OVERVIEW_LIMIT, desks = null}) {
  if (typeof deskId !== 'string' || !deskId) throw new Error('Overview requires a desk ID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(`Overview limit must be an integer between 1 and ${MAX_LIMIT}`);
  if (threadId !== null && threadId !== undefined && !uuid.test(threadId))
    throw new Error('Overview thread filter must be an exact manager chat UUID');

  const registry = desks ?? new Desks({store, config});
  const desk = registry.require(deskId);

  const leaseByWorker = new Map(store.writerLeases().map(lease => [lease.workerId, lease]));
  const allTasks = store.tasks();
  const taskById = new Map(allTasks.map(task => [task.id, task]));
  const deskWorkers = store.workers().filter(worker => worker.deskId === deskId);
  // Read every desk worker's durable requests exactly once. Records that cannot
  // be parsed or classified are collected as bounded, metadata-only issues
  // instead of being folded into a zero count.
  const requestReads = new Map(deskWorkers.map(worker => [worker.id, readRequests(store, worker.id)]));
  const requestIssues = [...requestReads.values()].flatMap(read => read.issues);

  // --- Projects (registered IDs/paths) -------------------------------------
  const projects = registry.projects(deskId).map(project => ({
    id: project.id, name: project.name ?? null, path: project.path ?? null,
  }));

  // --- Agents (recorded), optionally narrowed by owner chat ----------------
  const matchingWorkers = threadId
    ? deskWorkers.filter(worker => taskById.get(worker.taskId)?.threadId === threadId)
    : deskWorkers;

  const agents = matchingWorkers.map(worker => {
    const task = taskById.get(worker.taskId) ?? null;
    const retirement = storedRetirement(store, worker.id);
    const lease = leaseByWorker.get(worker.id) ?? null;
    const read = requestReads.get(worker.id) ?? readRequests(store, worker.id);
    const pendingReports = store.messages({taskId: worker.taskId, pending: true})
      .filter(message => message.workerId === worker.id);
    const openRequests = read.ok ? read.records.filter(request => OPEN_REQUEST_STATES.has(request.state)) : [];
    // A recorded stopped/finished launch state is the ONLY evidence that the
    // process is not live. A pending retirement request is not a stop: it only
    // records an unconfirmed stop barrier, so it is reported separately as
    // `retained` and never implies `stoppedButHeld`.
    const stopped = ['stopped', 'finished'].includes(worker.launchState);
    const retained = Boolean(lease) && retirement?.state === 'pending_retirement';
    return {
      agentId: worker.id,
      taskId: worker.taskId,
      name: worker.name ?? null,
      role: worker.deskDefinitionId ?? worker.role ?? null,
      roleVersion: worker.deskDefinitionVersion ?? null,
      harness: worker.role ?? null,
      ownerChat: task?.threadId ?? null,
      terminal: worker.terminalId ?? null,
      project: worker.project ?? null,
      definitionId: worker.deskDefinitionId ?? null,
      lifecycle: {
        launchState: worker.launchState ?? null,
        taskStatus: task?.status ?? null,
        retirementState: retirement?.state ?? null,
      },
      writerLeaseHeld: Boolean(lease),
      // Recorded stopped state plus a still-held lease is exactly the honest
      // "stopped-but-held ownership" case: the process is recorded as not live,
      // yet the checkout is still owned until complete clearance releases it.
      ownership: {
        held: Boolean(lease),
        stoppedButHeld: Boolean(lease) && stopped,
        retained,
      },
      pendingReports: pendingReports.length,
      pendingRequests: read.ok ? openRequests.length : null,
      // Stable reason code only (never raw parse/SQL text, which can embed
      // untrusted input). The bounded top-level `errors` list carries the
      // worker/row metadata for every affected record.
      requestError: read.ok ? null : read.issues[0].reason,
    };
  });

  // --- Writer reservations on this desk's exact checkouts ------------------
  // A reservation is relevant when its recorded paths overlap the desk home or
  // any registered project path. This list is intentionally NOT thread-filtered
  // and exposes only minimal ownership metadata -- never report/message bodies.
  const roots = [desk.home, ...projects.map(project => project.path)].filter(Boolean);
  const reservations = [...leaseByWorker.values()]
    .filter(lease => lease.paths.some(path => roots.some(root => pathOverlap(path, root))))
    .map(lease => {
      const worker = store.worker(lease.workerId) ?? null;
      const task = worker ? taskById.get(worker.taskId) ?? null : null;
      const retirement = worker ? storedRetirement(store, worker.id) : null;
      return {
        workerId: lease.workerId,
        taskId: worker?.taskId ?? null,
        deskId: worker?.deskId ?? null,
        ownerChat: task?.threadId ?? null,
        paths: lease.paths,
        retained: retirement?.state === 'pending_retirement',
        retirementState: retirement?.state ?? null,
        recordedLaunchState: worker?.launchState ?? null,
      };
    });

  // --- Totals --------------------------------------------------------------
  const deskTasks = allTasks.filter(task => task.deskId === deskId);
  const pendingReportsTotal = store.messages({pending: true})
    .filter(message => deskTasks.some(task => task.id === message.taskId)).length;
  // If any worker's request records could not be read or classified, the desk
  // total is reported as unknown (null) rather than as a misleading zero.
  const pendingRequestsTotal = requestIssues.length ? null : deskWorkers.reduce((count, worker) =>
    count + (requestReads.get(worker.id)?.records ?? []).filter(request => OPEN_REQUEST_STATES.has(request.state)).length, 0);

  const projectList = bounded(projects, limit);
  const agentList = bounded(agents, limit);
  const reservationList = bounded(reservations, limit);
  const errorList = bounded(requestIssues, limit);

  return {
    version: 1,
    generatedAt: now(),
    verification: {
      live: false,
      note: 'Recorded integration records only. No native terminal, process or checkout liveness was checked.',
    },
    // Bounded, metadata-only request-record issues. Empty when every worker's
    // durable requests were read and classified; when non-empty, affected
    // `pendingRequests` counts are `null` (unknown) and must not be read as zero.
    // Items are `{workerId,row,reason}` with stable reason codes only.
    errors: {...errorList, note: 'Stable reason codes with worker/row metadata; no record contents.'},
    desk: {
      id: desk.id,
      name: desk.name ?? null,
      status: desk.status ?? null,
      home: desk.home ?? null,
    },
    filter: {threadId: threadId ?? null},
    projects: projectList,
    agents: agentList,
    totals: {
      projects: projects.length,
      agents: deskWorkers.length,
      agentsShown: agentList.items.length,
      tasks: deskTasks.length,
      pendingReports: pendingReportsTotal,
      pendingRequests: pendingRequestsTotal,
      writerReservations: reservations.length,
    },
    reservations: {
      ...reservationList,
      threaded: false,
      note: 'Minimal ownership metadata for reservations on this desk\'s checkouts; not hidden by thread filtering and free of report contents.',
    },
    truncated: projectList.truncated || agentList.truncated || reservationList.truncated || errorList.truncated,
  };
}

import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID}$`, 'i');
const QUEUE_RECEIPT = new RegExp(`^Queued message (${UUID}) for thread (${UUID})\\.$`, 'i');
const ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  'TZ', 'SystemRoot', 'USERPROFILE', 'TERM',
]);
const NOT_STARTED = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC', 'EISDIR']);

/** Host paths/locale only. A worker's provider credentials never reach Codex. */
export function buildHostEnv(source = process.env) {
  const result = Object.create(null);
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length && !value.includes('\0')) result[key] = value;
  }
  return result;
}

/** Accept only one complete receipt addressed to the supplied existing chat. */
export function parseQueueReceipt(stdout, threadId) {
  if (typeof stdout !== 'string' || !UUID_PATTERN.test(threadId ?? '')) {
    return { receipt: null, error: 'No valid queue receipt.' };
  }
  const candidates = stdout.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^Queued message\b/i.test(line));
  if (candidates.length !== 1) {
    return { receipt: null, error: candidates.length ? 'Multiple queue receipts were returned.' : 'No queue receipt was returned.' };
  }
  const match = QUEUE_RECEIPT.exec(candidates[0]);
  if (!match) return { receipt: null, error: 'Malformed queue receipt.' };
  if (match[2].toLowerCase() !== threadId.toLowerCase()) {
    return { receipt: null, error: 'Queue receipt targets a different chat.' };
  }
  return { receipt: match[1].toLowerCase(), error: null };
}

function runCodex(executable, args, { env, timeoutMs }) {
  return new Promise(resolve => {
    try {
      execFile(executable, args, {
        env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true,
        encoding: 'utf8', shell: false,
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
          signal: error?.signal ?? null,
          timedOut: Boolean(error?.killed && error?.signal),
          spawnError: error && NOT_STARTED.has(error.code) ? error.code : null,
          transportError: error && typeof error.code === 'string' && !NOT_STARTED.has(error.code) ? error.code : null,
        });
      });
    } catch (error) {
      // Invalid argv/options fail synchronously, before a process is started.
      resolve({ code: null, stdout: '', stderr: '', spawnError: 'INVALID_INVOCATION' });
    }
  });
}

function warningFor(stderr, resume) {
  if (!String(stderr ?? '').trim()) return null;
  // Keep raw stderr out of shared logs: it can contain host paths, prompt text,
  // or unrelated configuration. The caller needs the delivery implication.
  if (resume && /(?:fail(?:ed|ure)?[^\n]*resum|(?:cannot|can't|could not|couldn't|unable to)[^\n]*resum|resum[^\n]*(?:fail|unavailable|not running))/i.test(stderr)) {
    return 'Codex reported that resuming the chat failed. The message may be queued, but wake delivery is unconfirmed.';
  }
  return 'Codex emitted diagnostics. Queue acceptance does not confirm chat receipt or wake delivery.';
}

function result(status, receipt = null, warning = null, error = null) {
  return { status, receipt, warning, error };
}

/**
 * Queue text for one registered existing Codex chat. This never starts a daemon,
 * opens a new chat, selects a model, or uses a shell. `queued` means only that
 * the CLI returned its exact receipt, not that Codex received/processed it.
 *
 * `runner` is a test seam: async (executable, argv, {env, timeoutMs}) =>
 * {code, stdout, stderr, signal?, timedOut?, spawnError?, transportError?}.
 */
export async function dispatchCodex({
  executable, threadId, message, env = process.env, timeoutMs = 30_000,
  resume = false, runner = runCodex,
} = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) {
    return result('failed', null, null, 'Codex executable must be an absolute path.');
  }
  if (typeof threadId !== 'string' || !UUID_PATTERN.test(threadId)) {
    return result('failed', null, null, 'An existing Codex chat UUID is required.');
  }
  if (typeof message !== 'string' || !message.trim() || message.includes('\0')) {
    return result('failed', null, null, 'Message must be nonempty text without NUL bytes.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof resume !== 'boolean' || typeof runner !== 'function') {
    return result('failed', null, null, 'Invalid host transport options.');
  }

  const args = ['queue', '--thread', threadId, '--message', message];
  if (resume) args.push('--resume');
  let response;
  try {
    response = await runner(executable, args, { env: buildHostEnv(env), timeoutMs });
  } catch (error) {
    if (NOT_STARTED.has(error?.code)) {
      return result('failed', null, null, 'Codex could not be started; no queue receipt was obtained.');
    }
    return result('uncertain', null, null, 'Host transport ended without a receipt; the message may already be queued.');
  }
  if (!response || typeof response !== 'object') {
    return result('uncertain', null, null, 'Host transport returned no valid result; queue delivery is unknown.');
  }
  const parsed = parseQueueReceipt(response.stdout, threadId);
  const warning = warningFor(response.stderr, resume);
  if (response.spawnError) {
    // A receipt and a claimed spawn failure contradict each other; do not retry
    // as a definite failure and risk duplicating a possibly accepted message.
    return parsed.receipt
      ? result('uncertain', parsed.receipt, warning, 'Host transport reported conflicting receipt and startup results.')
      : result('failed', null, warning, 'Codex could not be started; no queue receipt was obtained.');
  }
  if (response.timedOut || response.signal || response.transportError) {
    return result('uncertain', parsed.receipt, warning,
      'Host transport was interrupted; the message may already be queued. Reconcile before retrying.');
  }
  if (response.code === 0 && parsed.receipt) return result('queued', parsed.receipt, warning);
  if (parsed.receipt) {
    return result('uncertain', parsed.receipt, warning, 'Codex returned a queue receipt but did not exit successfully.');
  }
  if (response.code === 0) {
    return result('uncertain', null, warning, `${parsed.error} Queue delivery is unknown.`);
  }
  // A malformed/foreign receipt still suggests a queue mutation occurred. Never
  // treat it as safe-to-repeat, or expose the foreign receipt for queue cleanup.
  if (typeof response.stdout === 'string' && /^\s*Queued message\b/im.test(response.stdout)) {
    return result('uncertain', null, warning, `${parsed.error} Queue delivery is unknown.`);
  }
  if (Number.isInteger(response.code) && response.code !== 0) {
    return result('failed', null, warning, `Codex exited with code ${response.code} without a confirmed queue receipt.`);
  }
  return result('uncertain', null, warning, 'Host transport did not report a final exit status; queue delivery is unknown.');
}

import { LIMITS, validateWorkerEvidence } from './evidence.mjs';

/**
 * Worker-report evidence transport.
 *
 * Raw evidence v1 is optional on a worker message. It is validated (and its
 * worker/task identity bound to the actual message) before any durable write.
 * The raw object is preserved exactly as claimed; the validator's normalized
 * `authority: 'worker-claims'` tag is never stored, so it cannot be mistaken for
 * a worker-provided trusted assertion. Read adapters add their own explicit
 * label. Nothing here executes tests or dereferences artifact/output paths.
 */

export const MAX_EVIDENCE_BYTES = LIMITS.maxEvidenceBytes;

/**
 * Admission budget for a worker message's text, measured in UTF-8 bytes (not
 * characters), so multibyte text cannot slip past a codepoint count. Enforced
 * identically at the CLI (before any outbox/native write), the mailbox append
 * boundary, and the durable Store. The evidence envelope keeps its own 1 MiB
 * allowance without truncation.
 */
export const MAX_TEXT_BYTES = 65536;

/** Deep canonical form: object keys are sorted; array order is preserved. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

/** Stable JSON for a raw evidence value; key ordering never changes identity. */
export function canonicalEvidence(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Validate optional raw worker evidence and bind it to the sending identity.
 * Returns the raw evidence (or null when absent). Throws on malformed/unknown
 * fields or a worker/task mismatch. The normalized validator output is used
 * only for validation and binding, never persisted.
 */
export function validateMessageEvidence(evidence, { workerId, taskId } = {}) {
  if (evidence === undefined) return null;
  const normalized = validateWorkerEvidence(evidence);
  if (workerId !== undefined && normalized.worker_id !== workerId) {
    throw new TypeError('worker evidence worker_id does not match the sending worker');
  }
  if (taskId !== undefined && normalized.task_id !== taskId) {
    throw new TypeError('worker evidence task_id does not match the message task');
  }
  return evidence;
}

/** Explicit, trusted label attached when worker evidence is surfaced. */
export const EVIDENCE_AUTHORITY = 'worker-claims';

/** Read-adapter projection: raw evidence plus a separate worker-claims label. */
export function exposeEvidence(evidence) {
  return evidence === undefined || evidence === null
    ? { evidence: null, evidence_authority: null }
    : { evidence, evidence_authority: EVIDENCE_AUTHORITY };
}

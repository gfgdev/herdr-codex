import { HerdrError } from './native.mjs';
import { validateMessageEvidence, MAX_TEXT_BYTES } from './evidence-transport.mjs';

export const MAILBOX_DOC_LIMIT = 1024 * 1024;
const DOC_LIMIT = MAILBOX_DOC_LIMIT;
const CAS_ATTEMPTS = 16;
const KINDS = new Set(['question', 'result', 'progress']);

function invalid(message, code = 'MAILBOX_INVALID') {
  return new HerdrError(message, { code });
}

function nameOf(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_.-]{1,32}$/.test(name)) throw invalid('Invalid Herdr mailbox name');
  return name;
}

function validateStructure(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw invalid('Mailbox message must be an object');
  for (const key of ['id', 'taskId', 'workerId', 'terminalId', 'createdAt']) {
    if (typeof message[key] !== 'string' || !message[key] || message[key].length > 256 || message[key].includes('\0')) {
      throw invalid(`Mailbox message requires a valid ${key}`);
    }
  }
  if (!KINDS.has(message.kind)) throw invalid('Unknown mailbox message kind');
  if (typeof message.text !== 'string' || !message.text.trim()) throw invalid('Mailbox message text is required');
  if (message.idempotencyKey !== undefined && (typeof message.idempotencyKey !== 'string' || !message.idempotencyKey)) {
    throw invalid('Invalid mailbox idempotency key');
  }
  return message;
}

/**
 * Admission validation for newly appended messages. Structural checks plus the
 * UTF-8 text budget, the Store-compatible ID shape, and evidence validation and
 * identity binding, all before any CAS write. Reading existing documents
 * deliberately uses only validateStructure: a legacy oversized message, or one
 * carrying invalid evidence, stays structurally readable so the Store can
 * classify and archive it per entry without blocking following valid reports.
 */
function validateAdmission(message) {
  validateStructure(message);
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(message.id)) throw invalid('Mailbox message ID must be 1-128 characters of [A-Za-z0-9._-]', 'MAILBOX_INVALID');
  if (Buffer.byteLength(message.text) > MAX_TEXT_BYTES) throw invalid(
    `Mailbox message text exceeds the ${MAX_TEXT_BYTES}-byte admission budget`, 'MAILBOX_TOO_LARGE',
  );
  // Optional raw evidence is validated and bound to this message's identity at
  // the mailbox boundary, before any CAS write. Historical messages omit it.
  if (message.evidence !== undefined) {
    try {
      validateMessageEvidence(message.evidence, { workerId: message.workerId, taskId: message.taskId });
    } catch (error) {
      throw invalid('Invalid mailbox worker evidence: ' + error.message);
    }
  }
  return message;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}

function encodedDocument(messages) {
  const value = { version: 1, messages };
  if (Buffer.byteLength(JSON.stringify(value)) > DOC_LIMIT) throw invalid(
    'Herdr mailbox is full; pending messages must be durably ingested before adding more', 'MAILBOX_FULL',
  );
  return value;
}

/** Returns the native CAS version separately from the document format version. */
export async function readMailbox(client, name) {
  nameOf(name);
  const result = await client.request('doc.get', { name });
  if (!result || !Number.isSafeInteger(result.version) || result.version < 0) throw invalid('Invalid Herdr document version');
  if (result.value === null) return { version: result.version, messages: [] };
  const doc = result.value;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.messages)) throw invalid('Unsupported or malformed mailbox document');
  const ids = new Set();
  for (const message of doc.messages) {
    validateStructure(message);
    if (ids.has(message.id)) throw invalid('Mailbox contains duplicate message IDs');
    ids.add(message.id);
  }
  encodedDocument(doc.messages);
  return { version: result.version, messages: doc.messages };
}

/** Stable IDs are idempotent only when the entire stored payload agrees. */
export async function appendMessage(client, worker, message) {
  const name = nameOf(worker.mailbox);
  // Clone through JSON before use: persisted identity cannot change underneath
  // an awaited CAS operation, and unsupported/cyclic values fail before writing.
  const copy = JSON.parse(JSON.stringify(message));
  validateAdmission(copy);
  if (copy.taskId !== worker.taskId || copy.workerId !== worker.id) throw invalid('Message does not belong to this worker', 'MAILBOX_ROUTE');
  const payload = JSON.stringify(canonical(copy));
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await readMailbox(client, name);
    const existing = current.messages.find(entry => entry.id === copy.id);
    if (existing) {
      if (JSON.stringify(canonical(existing)) !== payload) throw invalid('Message ID already has a different payload', 'MAILBOX_ID_CONFLICT');
      return { ...current, duplicate: true };
    }
    const messages = [...current.messages, copy];
    try {
      const result = await client.request('doc.set', { name, version: current.version, value: encodedDocument(messages) });
      return { version: result.version, messages, duplicate: false };
    } catch (error) {
      if (error.data?.kind !== 'conflict') throw error;
    }
  }
  throw invalid('Mailbox changed repeatedly; retry the same message ID', 'MAILBOX_CONTENTION');
}

/** Caller must durably ingest these IDs before pruning; concurrent appends survive. */
export async function pruneMailbox(client, name, ids) {
  nameOf(name);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw invalid('Prune requires message IDs');
  const remove = new Set(ids);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await readMailbox(client, name);
    const messages = current.messages.filter(message => !remove.has(message.id));
    const removed = current.messages.length - messages.length;
    if (!removed) return { ...current, removed: 0 };
    try {
      const result = await client.request('doc.set', { name, version: current.version, value: encodedDocument(messages) });
      return { version: result.version, messages, removed };
    } catch (error) {
      if (error.data?.kind !== 'conflict') throw error;
    }
  }
  throw invalid('Mailbox changed repeatedly; retry pruning the same IDs', 'MAILBOX_CONTENTION');
}

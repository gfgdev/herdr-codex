import { HerdrClient, HerdrError } from './native.mjs';

/**
 * A single logical RPC endpoint that lazily opens one native `hc connect`
 * connection and, once that connection has closed, opens exactly one
 * replacement on the NEXT explicit request.
 *
 * It deliberately never replays the request that observed the closure: an
 * in-flight mutation may already have reached Herdr, so the caller keeps the
 * original uncertainty and decides whether to retry. Concurrent calls that
 * arrive after a closure share the one replacement, and a late close from an
 * already-replaced connection cannot discard the newer one.
 *
 * `createClient` is injectable so tests can drive close ordering that a real
 * `hc connect` process cannot produce deterministically; production uses the
 * real `HerdrClient`.
 */
export function createRpcConnection({ hc, timeoutMs = 90_000, createClient } = {}) {
  if (typeof createClient !== 'function' && (typeof hc !== 'string' || !hc)) {
    throw new TypeError('createRpcConnection requires an hc executable or a createClient factory');
  }
  let client = null;
  let closed = false;
  let closeError;

  const open = () => {
    let created;
    // A close only releases the slot if this exact client still occupies it.
    // A stale connection must never discard the replacement.
    const onClose = () => { if (client === created) client = null; };
    created = typeof createClient === 'function'
      ? createClient({ onClose })
      : new HerdrClient({ hc, timeoutMs, onClose });
    return created;
  };

  return {
    get client() { return client; },
    get closed() { return closed; },
    request(method, params) {
      if (closed) {
        return Promise.reject(closeError ?? new HerdrError('Herdr connection closed', { code: 'CLIENT_CLOSED' }));
      }
      const current = client && !client.closed ? client : (client = open());
      // Issue against the client that is current at this moment. A later
      // replacement never rewrites, retries or settles this request.
      return current.request(method, params);
    },
    close() {
      if (closed) return;
      closed = true;
      closeError = new HerdrError('Herdr runtime connection closed', { code: 'CLIENT_CLOSED' });
      const current = client;
      client = null;
      current?.close();
    },
  };
}

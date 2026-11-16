import { spawn } from 'node:child_process';

const DEFAULT_LINE_LIMIT = 16 * 1024 * 1024;

export class HerdrError extends Error {
  constructor(message, { code = 'HERDR_ERROR', data, cause, uncertain = false } = {}) {
    super(message, { cause });
    this.name = 'HerdrError';
    this.code = code;
    if (data !== undefined) this.data = data;
    this.uncertain = uncertain;
  }
}

/** A native `hc connect` connection. Use a separate client for subscriptions. */
export class HerdrClient {
  constructor({ hc, env, timeoutMs = 15_000, onClose, maxLineBytes = DEFAULT_LINE_LIMIT }) {
    if (typeof hc !== 'string' || !hc) throw new TypeError('hc executable is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError('maxLineBytes must be positive');
    this.timeoutMs = timeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 1;
    this.mode = 'rpc';
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.child = spawn(hc, ['connect'], {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stdout.on('error', cause => this.fail(new HerdrError('Herdr output connection failed', {
      code: 'HERDR_DISCONNECTED', cause, uncertain: this.pending.size > 0,
    })));
    this.child.stderr.on('error', () => {});
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-65_536);
    });
    this.child.stdin.on('error', cause => this.fail(new HerdrError('Herdr input connection failed', {
      code: 'HERDR_DISCONNECTED', cause, uncertain: this.pending.size > 0,
    })));
    this.child.on('error', cause => this.fail(new HerdrError('Could not start hc connect', {
      code: 'HERDR_SPAWN_FAILED', cause,
    })));
    this.child.stdout.on('end', () => this.fail(new HerdrError(
      this.buffer.length ? 'Herdr connection ended during a JSON response' : 'Herdr connection closed',
      { code: 'HERDR_DISCONNECTED', uncertain: this.pending.size > 0 },
    )));
    this.child.on('exit', (code, signal) => this.fail(new HerdrError('hc connect exited', {
      code: 'HERDR_DISCONNECTED', data: { exitCode: code, signal }, uncertain: this.pending.size > 0,
    })));
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(this.closeError);
    if (this.mode !== 'rpc') return Promise.reject(new HerdrError('Subscription clients cannot send RPC requests', {
      code: 'HERDR_SUBSCRIPTION_ONLY',
    }));
    return this.send(method, params);
  }

  subscribe(onNotification) {
    if (this.closed) return Promise.reject(this.closeError);
    if (typeof onNotification !== 'function') return Promise.reject(new TypeError('A notification callback is required'));
    if (this.mode !== 'rpc' || this.pending.size) return Promise.reject(new HerdrError(
      'Subscribe on an unused connection with no pending requests', { code: 'HERDR_CONNECTION_BUSY' },
    ));
    this.mode = 'subscription';
    this.onNotification = onNotification;
    return this.send('events.subscribe', {});
  }

  send(method, params) {
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('A method name is required'));
    const id = this.nextId++;
    let line;
    try {
      line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    } catch (cause) {
      return Promise.reject(new HerdrError('Request is not JSON serializable', { code: 'HERDR_INVALID_REQUEST', cause }));
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) return Promise.reject(new HerdrError('Herdr request exceeds line limit', {
      code: 'HERDR_LIMIT',
    }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new HerdrError(`Herdr ${method} response timed out`, {
        code: 'HERDR_TIMEOUT', uncertain: true,
      })), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, error => {
        if (error) this.fail(new HerdrError('Could not write Herdr request', {
          code: 'HERDR_DISCONNECTED', cause: error, uncertain: true,
        }));
      });
    });
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end > this.maxLineBytes) return this.fail(new HerdrError('Herdr response exceeds line limit', {
        code: 'HERDR_LIMIT', uncertain: this.pending.size > 0,
      }));
      const line = this.buffer.subarray(0, end).toString('utf8').trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (!line) continue;
      try {
        this.receive(JSON.parse(line));
      } catch (cause) {
        return this.fail(new HerdrError('Invalid Herdr JSON-RPC response', {
          code: 'HERDR_PROTOCOL', cause, uncertain: this.pending.size > 0,
        }));
      }
      if (this.closed) return;
    }
    if (this.buffer.length > this.maxLineBytes) this.fail(new HerdrError('Herdr response exceeds line limit', {
      code: 'HERDR_LIMIT', uncertain: this.pending.size > 0,
    }));
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      throw new Error('Invalid envelope');
    }
    if (!Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      if (!this.onNotification) throw new Error('Unexpected notification on RPC connection');
      // Async consumers can queue their work; a rejected consumer is surfaced to
      // the bridge rather than becoming an unhandled rejection or losing events.
      Promise.resolve(this.onNotification(message)).catch(cause => this.fail(new HerdrError('Herdr notification consumer failed', {
        code: 'HERDR_CONSUMER', cause,
      })));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) throw new Error('Unmatched response');
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      const error = message.error;
      if (!error || typeof error.message !== 'string' || typeof error.code !== 'number') {
        const invalid = new HerdrError('Invalid Herdr error response', { code: 'HERDR_PROTOCOL', uncertain: true });
        pending.reject(invalid);
        this.fail(invalid);
        return;
      }
      pending.reject(new HerdrError(error.message, { code: error.code, data: error.data }));
    } else {
      pending.resolve(message.result);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.kill('SIGTERM'); // Only this client's hc connect process.
    if (this.onClose) {
      // Lifecycle callbacks must not create unhandled asynchronous rejections.
      try { Promise.resolve(this.onClose(error)).catch(() => {}); } catch {}
    }
  }

  close() {
    this.fail(new HerdrError('Herdr client closed', { code: 'CLIENT_CLOSED', uncertain: this.pending.size > 0 }));
  }
}

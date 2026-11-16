import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, dbPath } from './config.mjs';
import { Store } from './store.mjs';
import { createRpcConnection } from './rpc-connection.mjs';
import { Delegation } from './delegation.mjs';
import { Retirement, noCoverage } from './retirement.mjs';
import { Notifications } from './notifications.mjs';
import { createJournalPublisher } from './activity-ipc.mjs';
import { waitForAgentActivity } from './activity-wait.mjs';
import { showWorker } from './desktop.mjs';
import { Desks } from './desks.mjs';
import { AgentTools } from './agent-tools.mjs';
import { publishRuntimeSnapshot } from './runtime-snapshot.mjs';

const execute = promisify(execFile);
export async function createAgentTools(configPath) {
  const installationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = { ...readConfig(configPath), packageRoot: installationRoot };
  // The MCP server outlives the plugin install it was started from: pin the CLI
  // it shells out to (and every delegation it prepares) to an immutable copy.
  const runtime = await publishRuntimeSnapshot({ packageRoot: installationRoot, stateDir: config.stateDir });
  config.runtimeRoot = runtime.root;
  config.packageRoot = runtime.root;
  const publisher = createJournalPublisher(dbPath(config));
  const store = new Store(dbPath(config), { onJournal: publisher });
  let starting;
  // A closed native connection (for example after core restarts) is replaced on
  // the next explicit request; the request that observed the closure is never
  // replayed, so a mutation is not silently attempted twice.
  const rpc = createRpcConnection({ hc: config.hc, timeoutMs: 90000 });
  const pulse = async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await rpc.request('doc.get', { name: config.registryDoc });
      try {
        await rpc.request('doc.set', { name: config.registryDoc, version: current.version, value: { changedAt: new Date().toISOString(), nonce: randomUUID() } });
        return;
      } catch (error) { if (error.data?.kind !== 'conflict') throw error; }
    }
    throw new Error('Registry changed concurrently; saved work must be inspected before retrying');
  };
  const cli = async args => {
    try {
      const { stdout } = await execute(config.node, [resolve(config.packageRoot, 'src/cli.mjs'), '--config', config.path, ...args], { maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      // Do not leak execFile's command (which contains the assignment) or raw stderr.
      const last = error.stderr?.trim().split('\n').reverse().find(line => line.startsWith('{'));
      let detail; try { detail = JSON.parse(last).error; } catch {}
      throw new Error(detail ?? 'Herdr lifecycle command failed; inspect the saved request before retrying');
    }
  };
  // Every writer release in this runtime funnels through one shared retirement
  // service. Production default coverage is `unknown`, so a confirmed native
  // exit marks the worker stopped but RETAINS writer ownership as
  // `pending_retirement` until descendant clearance is explicitly complete.
  const retirement = new Retirement(store, { provider: config.containmentProvider ?? noCoverage, trustedSources: config.trustedContainmentSources ?? null });
  const delegation = new Delegation({ config, store, rpc, pulse, retirement });
  // Mirrors `cli.mjs show`: verified native placement. AgentTools.placeAgent
  // turns any desktop failure into a placement warning, so a launched worker is
  // never failed, closed or repeated because its panel could not be opened.
  const appCall = async (method, params) => {
    const { stdout } = await execute(config.app, method === 'ls' ? ['ls'] : ['do', method, JSON.stringify(params)], { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const place = (worker, options = {}) => showWorker({ worker, place: options.place ?? 'tab', spaceId: options.spaceId,
    // An explicit show authorizes creating exactly the canonical project space when none exists.
    createSpace: true, appCall, getTerminal: terminal => rpc.request('terminal.get', { terminal }),
    ...(worker.deskId ? { desk: new Desks({ store, config }).show(worker.deskId), getRegisteredWorker: terminalId => store.workers().find(w => w.terminalId === terminalId) } : {}) });
  const adapter = new AgentTools({ config, store, delegation, notices: new Notifications({ store, config }),
    place,
    wait: options => waitForAgentActivity({ store, dbPath: dbPath(config), ...options }),
    ensureBridge: async () => {
      // Coalesce concurrent spawns in this server; the bridge owns the actual lock.
      starting ??= cli(['bridge', 'start']).finally(() => { starting = null; });
      const state = await starting;
      if (state.status !== 'listening' || state.activityProtocol !== 1) throw new Error('Herdr bridge is not listening with activity protocol 1; inspect bridge status before spawning');
    },
    resolveMessage: async (message, action) => {
      // Reuse the CLI's existing reply claim and uncertain-delivery recovery path.
      const args = ['message', action.kind === 'reply' ? 'reply' : 'decision', '--id', message.id, '--request-id', action.requestId, '--text', action.text];
      if (action.kind !== 'reply') args.push('--action', action.kind);
      await cli(args);
      // Existing Store guard refuses acknowledgement if a reply is still uncertain.
      return cli(['message', 'ack', '--id', message.id]);
    },
    flush: () => publisher.flush(),
  });
  return { adapter, async close() { try { await publisher.flush(); } finally { rpc.close(); store.close(); } } };
}

#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_TOOLS } from './agent-tools.mjs';

export const MCP_INSTRUCTIONS = 'When the user selects Herdr, use these tools as your subagent interface: spawn_agent, send_message, followup_task, interrupt_agent, stop_agent, list_agents, wait_agent. Bind every call to this chat’s exact UUID. Keep task_name stable across retries. Supply a focused context brief; full conversation forks are unavailable. The configured Herdr provider/model is preserved. Receive bridge notifications with receive_notification; it returns a compact, replayable review-packet summary (stable batch_id plus every current report ID and state) instead of full report text. Reuse the same batch_id to recover a lost response, and page bounded untrusted detail with read_review_packet. read_agent returns bounded report metadata by default; pass include_reports for full text or include_messages:false for a terminal-only read. wait_agent likewise returns bounded pending-report metadata by default; pass include_reports for full untrusted text. resolve_message returns a short action/delivery/acknowledgement receipt; for action:accept you may bind a captured review by supplying review_id and expected_revision together with an explicit request_id, in which case the acceptance is validated and recorded through the revision-review service and acknowledged once, and an exact replay is historical only (call verify_review to observe later drift). capture_review binds an explicit, bounded set of project-relative paths from one result to a revision of the exact registered worker project; reuse the same request_id to replay the identical capture, and expect only a compact identity/digest/count receipt. verify_review re-checks the recorded acceptance for one result against the current files and its captured revision binding, returning explicit accepted/bound/verified/stale flags with a reason, expected/actual digests and bounded changed-path counts; it is read-only, a legacy acceptance reports bound=false/verified=null, and a historical acceptance is never current completion. Native idle/done and result reports are not verified acceptance. The CLI remains available for recovery and broader Herdr capabilities.';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

/** Dependency-free MCP stdio subset: tools, ping, cancellation, concurrent calls.
 * Lifecycle effects remain in Herdr. Disconnect aborts waits, never workers.
 */
export async function serveAgentMcp({ input = process.stdin, output = process.stdout, runtimeFactory, version = '0.8.2' }) {
  let buffer = '', initialized = false, closing = false, runtimePromise;
  const pending = new Map();
  const runtime = () => runtimePromise ??= Promise.resolve().then(runtimeFactory).catch(error => { runtimePromise = undefined; throw error; });
  const send = value => { if (!output.destroyed && !output.writableEnded) output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  const failure = (id, code, message) => send({ id, error: { code, message } });
  async function dispatch(request) {
    const id = request?.id;
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id))) { failure(null, -32600, 'Invalid request'); return; }
    if (id === undefined) {
      if (request.method === 'notifications/cancelled') pending.get(request.params?.requestId)?.controller.abort(new Error('MCP request cancelled; worker lifecycle unchanged'));
      return;
    }
    if (pending.has(id)) { failure(id, -32600, 'Request ID is already in flight'); return; }
    if (request.method === 'initialize') {
      if (initialized) { failure(id, -32600, 'Already initialized'); return; }
      initialized = true;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      send({ id, result: { protocolVersion: supported.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'herdr-agents', version }, instructions: MCP_INSTRUCTIONS } });
      return;
    }
    if (request.method === 'ping') { send({ id, result: {} }); return; }
    if (!initialized) { failure(id, -32000, 'Initialize first'); return; }
    if (request.method === 'tools/list') { send({ id, result: { tools: AGENT_TOOLS } }); return; }
    if (request.method !== 'tools/call') { failure(id, -32601, 'Method not found'); return; }
    if (!AGENT_TOOLS.some(tool => tool.name === request.params?.name)) { failure(id, -32602, 'Unknown tool'); return; }
    const controller = new AbortController();
    const operation = Promise.resolve().then(async () => {
      try {
        const { adapter } = await runtime();
        const value = await adapter.call(request.params.name, request.params.arguments ?? {}, { signal: controller.signal });
        if (!controller.signal.aborted) send({ id, result: result(value) });
      } catch (error) {
        if (!controller.signal.aborted) send({ id, result: { ...result({ error: error.message, ...error.details }), isError: true } });
      } finally { pending.delete(id); }
    });
    pending.set(id, { controller, operation });
  }
  input.setEncoding('utf8');
  const consume = chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) { failure(null, -32600, 'Frame too large'); continue; }
      if (!line.trim()) continue;
      let request; try { request = JSON.parse(line); } catch { failure(null, -32700, 'Parse error'); continue; }
      void dispatch(request);
    }
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { failure(null, -32600, 'Frame too large'); input.destroy(); }
  };
  return new Promise((done, reject) => {
    const close = async () => {
      if (closing) return; closing = true; input.off('data', consume);
      for (const { controller } of pending.values()) controller.abort(new Error('MCP transport closed; worker lifecycle unchanged'));
      try {
        await Promise.allSettled([...pending.values()].map(p => p.operation));
        const r = await runtimePromise; await r?.close(); done();
      } catch (error) { reject(error); }
    };
    input.on('data', consume); input.once('end', close); input.once('close', close); input.once('error', close);
    output.once('error', close);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' } }, strict: true });
    await serveAgentMcp({ runtimeFactory: async () => (await import('./agent-tools-runtime.mjs')).createAgentTools(values.config) });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

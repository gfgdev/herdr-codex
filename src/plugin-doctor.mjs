/** Read-only setup doctor for the bundled Agent Plugins MCP server.
 *
 * It diagnoses the two failures that hide `herdr-agents` from a Codex chat:
 *  1. manifest/spec violations (a command that resolves outside the plugin
 *     root silently disables the server), and
 *  2. a missing executable bit on the packaged wrapper.
 * It then proves tool discovery by performing only the MCP handshake. No tool
 * is called, no worker is launched, no model is used, and nothing is written.
 * Remediation is returned as exact commands; global Codex config is never
 * modified here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AGENT_TOOLS } from './agent-tools.mjs';
import { findPluginRoot, validateMcpManifest, validatePluginManifest } from './plugin-manifest.mjs';

const execute = promisify(execFile);

/** Quote one argv token for a POSIX shell, keeping paths with spaces intact. */
export const shellArg = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Run a packaged stdio MCP server just long enough to prove tool discovery. */
export function probeMcp({ command, args = [], cwd, env, timeoutMs = 10000, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let out = '', err = '', settled = false, serverInfo = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`MCP probe timed out after ${timeoutMs} ms${err ? `; stderr: ${err.trim()}` : ''}`)), timeoutMs);
    child.once('error', error => finish(reject, error));
    // A wrapper that cannot start (for example an unbuilt package) exits before
    // answering; surface its stderr instead of waiting out the timeout.
    child.once('close', code => finish(reject, new Error(`MCP server exited with code ${code} before answering${err ? `; stderr: ${err.trim()}` : ''}`)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { err = (err + data).slice(-8192); });
    const handle = line => {
      let reply;
      try { reply = JSON.parse(line); }
      catch (error) { finish(reject, new Error(`Invalid MCP response: ${error.message}`)); return; }
      if (reply.id === 1) { serverInfo = reply.result?.serverInfo ?? null; return; }
      if (reply.id === 2) {
        const tools = reply.result?.tools?.map(item => item.name);
        if (!tools) { finish(reject, new Error('MCP tools/list returned no tools array')); return; }
        finish(resolve, { tools, serverInfo, stderr: err });
      }
    };
    // Frames are newline-delimited JSON. Keep an incomplete trailing frame
    // buffered instead of parsing a partial response as if it were complete.
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      buffered += data;
      let index;
      while (!settled && (index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (line.trim()) handle(line);
      }
    });
    const write = text => {
      if (settled) return;
      try { child.stdin.write(text); }
      catch (error) { finish(reject, new Error(`MCP server stdin failed: ${error.message}`)); }
    };
    child.stdin?.on?.('error', error => finish(reject, new Error(`MCP server stdin failed: ${error.message}`)));
    const frame = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    write(frame(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'herdr-codex-doctor', version: '1' } }));
    write(frame(2, 'tools/list', {}));
  });
}

/** Parse `codex mcp list --json` into server entries, or null when unparseable. */
export function parseMcpList(output) {
  let data;
  try { data = JSON.parse(output); } catch { return null; }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.servers)) return data.servers;
  if (data && typeof data === 'object') return Object.entries(data).map(([name, value]) => ({ name, ...(value && typeof value === 'object' ? value : {}) }));
  return [];
}

export async function pluginDoctorCommand({ packageRoot, probe = true, codex = null, timeoutMs = 10000, spawnProcess = spawn, run = null } = {}) {
  const checks = [];
  const remediation = [];
  const record = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };
  const pluginRoot = findPluginRoot(packageRoot);
  if (!pluginRoot) {
    return {
      ok: false, pluginRoot: null, plugin: null, servers: [], tools: [],
      checks: [{ name: 'plugin-root', ok: false, detail: 'No plugin.json/mcp.json found relative to the runtime' }],
      remediation: ['Rebuild the packaged plugin: node scripts/build-plugin.mjs --out /absolute/new/folder'],
    };
  }
  const readManifest = path => { try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (error) { return { error: error.message }; } };
  const pluginFile = readManifest(join(pluginRoot, 'plugin.json'));
  if (pluginFile.error) record('plugin-manifest', false, pluginFile.error);
  else {
    const result = validatePluginManifest(pluginFile.value);
    record('plugin-manifest', result.ok, result.ok ? `${result.name}@${result.version}` : result.problems.join('; '));
  }
  const mcpFile = readManifest(join(pluginRoot, 'mcp.json'));
  const servers = [];
  if (mcpFile.error) record('mcp-manifest', false, mcpFile.error);
  else {
    const result = validateMcpManifest(mcpFile.value, { pluginRoot });
    record('mcp-manifest', result.ok, result.ok ? result.servers.map(server => server.name).join(', ') : result.problems.join('; '));
    servers.push(...result.servers);
    if (!result.ok) remediation.push('Make every stdio command plugin-relative, e.g. "command": "./scripts/herdr-agents.sh"; absolute or ../ paths silently disable the server.');
  }
  const herdr = servers.find(server => server.name === 'herdr-agents') ?? servers[0] ?? null;
  if (herdr?.executable === false) {
    record('executable-bit', false, `${herdr.resolved} is not executable`);
    remediation.push(`chmod +x ${herdr.resolved}`);
  } else if (herdr?.resolved) record('executable-bit', true, herdr.resolved);

  const expected = AGENT_TOOLS.map(item => item.name);
  let tools = [];
  const sourceEntry = join(packageRoot, 'src', 'agent-mcp.mjs');
  const packaged = herdr?.resolved ? [herdr.resolved, []] : null;
  const fallback = existsSync(sourceEntry) ? [process.execPath, [sourceEntry]] : null;
  if (!probe) record('mcp-tools', null, 'skipped by --skip-probe');
  else if (!packaged && !fallback) record('mcp-tools', false, 'no resolvable stdio command to probe');
  else {
    const attempts = [packaged, fallback].filter(Boolean);
    let lastError, probed = null;
    for (const [command, args] of attempts) {
      try {
        const result = await probeMcp({
          command, args, cwd: pluginRoot, timeoutMs, spawnProcess,
          env: { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: join(pluginRoot, '.plugin-data'), HERDR_CODEX_NODE: process.execPath },
        });
        tools = result.tools; probed = command; lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (lastError) record('mcp-tools', false, lastError.message);
    else {
      const missing = expected.filter(name => !tools.includes(name));
      const source = fallback && probed === fallback[0];
      record('mcp-tools', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${tools.length} tools discovered${source ? ' from the source entrypoint (the packaged wrapper is not built yet)' : ''}`);
    }
  }

  if (!codex) record('host-mcp-surface', null, 'skipped; pass --codex PATH or run: codex mcp list --json');
  else {
    try {
      const runner = run ?? (async (file, args) => (await execute(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout);
      const output = await runner(codex, ['mcp', 'list', '--json']);
      const parsed = parseMcpList(output);
      if (parsed === null) record('host-mcp-surface', false, 'codex mcp list --json was not valid JSON');
      else {
        const entry = parsed.find(server => server?.name === 'herdr-agents');
        const enabled = Boolean(entry) && entry.enabled !== false && entry.disabled !== true;
        record('host-mcp-surface', enabled, !entry ? 'herdr-agents is not present in codex mcp list'
          : enabled ? 'codex mcp list reports herdr-agents enabled' : 'herdr-agents is present but disabled in codex mcp list');
      }
    } catch (error) { record('host-mcp-surface', false, `could not read codex mcp list: ${error.message}`); }
  }
  if (checks.some(check => check.name === 'host-mcp-surface' && check.ok === false) || (codex && checks.some(check => check.name === 'mcp-tools' && check.ok === false))) {
    const wrapper = herdr?.resolved ?? join(pluginRoot, 'scripts/herdr-agents.sh');
    remediation.push(['codex', 'mcp', 'add', 'herdr-agents', '--', '/bin/sh', wrapper].map(shellArg).join(' '));
    remediation.push('Then restart the Codex app so the chat reloads its tool list.');
  }
  return {
    ok: checks.every(check => check.ok !== false),
    pluginRoot,
    plugin: pluginFile.value ? { name: pluginFile.value.name ?? null, version: pluginFile.value.version ?? null } : null,
    servers: servers.map(server => ({ name: server.name, type: server.type, command: server.command, resolved: server.resolved })),
    tools, checks, remediation: [...new Set(remediation)],
  };
}

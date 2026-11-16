/** Dependency-free validation for this plugin's own Agent Plugins manifests.
 *
 * Confirmed host behavior (Codex 0.167.0-alpha.4.1): an Agent Plugins stdio
 * MCP `command` that resolves outside the plugin root silently disables the
 * whole server ("Agent Plugins MCP config resolves outside the plugin root;
 * disabling MCP"). Such a server never reaches the chat tool list.
 *
 * Agent Plugins 1.0.0 therefore requires plugin-relative path fields to begin
 * with "./" and remain inside the plugin root; command *arguments* and env
 * values are opaque strings, not paths. This module encodes exactly those
 * rules so setup/doctor and the packager can reject the failure before a user
 * hits it, without pulling in a JSON Schema dependency.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export const MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const PLUGIN_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const RESERVED_ENV = ['PLUGIN_ROOT', 'PLUGIN_DATA'];
const PLUGIN_FIELDS = ['$schema', 'name', 'version', 'description', 'homepage', 'repository', 'license', 'keywords', 'author', 'extensions'];
const CWD_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

const inside = (root, path) => path === root || path.startsWith(root + sep);

/** Validate the Agent Plugins manifest shipped as plugin.json. */
export function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, name: null, version: null, problems: ['plugin.json must be a JSON object'] };
  }
  const problems = [];
  if (manifest.$schema !== PLUGIN_SCHEMA_ID) problems.push(`plugin.json $schema must be ${PLUGIN_SCHEMA_ID}`);
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('plugin.json name is required');
  else if (manifest.name.length > 64 || !PLUGIN_NAME_PATTERN.test(manifest.name)) problems.push(`plugin.json name ${JSON.stringify(manifest.name)} is not a valid Agent Plugins name`);
  if (manifest.version !== undefined && (typeof manifest.version !== 'string' || !manifest.version)) problems.push('plugin.json version must be a nonempty string');
  if (manifest.extensions !== undefined && (typeof manifest.extensions !== 'object' || manifest.extensions === null || Array.isArray(manifest.extensions))) problems.push('plugin.json extensions must be an object');
  for (const key of Object.keys(manifest)) if (!PLUGIN_FIELDS.includes(key)) problems.push(`plugin.json has unsupported top-level field ${JSON.stringify(key)}`);
  return { ok: problems.length === 0, name: manifest.name ?? null, version: manifest.version ?? null, problems };
}

/** Resolve an Agent Plugins stdio command against the plugin root.
 * Returns { ok, path, reason } and never performs I/O. */
export function resolveCommand(command, pluginRoot) {
  if (typeof command !== 'string' || !command) return { ok: false, path: null, reason: 'stdio command must be a nonempty string' };
  const rooted = command.startsWith('./') || command.startsWith('../') ? command
    : /^\$\{PLUGIN_(?:ROOT|DATA)\}\//.test(command) ? command.replace(/^\$\{PLUGIN_(?:ROOT|DATA)\}\//, './')
      : null;
  if (rooted === null) {
    return isAbsolute(command)
      ? { ok: false, path: null, reason: `command ${JSON.stringify(command)} is an absolute path outside the plugin root` }
      : { ok: false, path: null, reason: `command ${JSON.stringify(command)} is a bare token; Agent Plugins stdio commands must be plugin-relative (./...)` };
  }
  const path = resolve(pluginRoot, rooted);
  if (!inside(pluginRoot, path)) return { ok: false, path: null, reason: `command ${JSON.stringify(command)} resolves outside the plugin root` };
  return { ok: true, path, reason: null };
}

/** Validate the Agent Plugins manifest shipped as mcp.json and resolve each
 * stdio command/executable-bit. Filesystem checks are read-only. */
export function validateMcpManifest(manifest, { pluginRoot = process.cwd() } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, servers: [], problems: ['mcp.json must be a JSON object'] };
  }
  const problems = [];
  const servers = [];
  if (manifest.$schema !== MCP_SCHEMA_ID) problems.push(`mcp.json $schema must be ${MCP_SCHEMA_ID}`);
  for (const key of Object.keys(manifest)) if (key !== '$schema' && key !== 'mcpServers') problems.push(`mcp.json has unsupported top-level field ${JSON.stringify(key)}`);
  const entries = manifest.mcpServers;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || !Object.keys(entries).length) problems.push('mcp.json mcpServers must be a nonempty object');
  for (const [name, server] of Object.entries(entries ?? {})) {
    const entry = { name, type: server?.type ?? null, command: null, resolved: null, executable: null };
    if (!server || typeof server !== 'object' || Array.isArray(server)) { problems.push(`server ${JSON.stringify(name)} must be an object`); servers.push(entry); continue; }
    if (server.type === 'stdio') {
      entry.command = server.command;
      const resolved = resolveCommand(server.command, pluginRoot);
      if (!resolved.ok) problems.push(`server ${JSON.stringify(name)}: ${resolved.reason}`);
      else {
        entry.resolved = resolved.path;
        if (!existsSync(resolved.path)) problems.push(`server ${JSON.stringify(name)}: command ${resolved.path} does not exist`);
        else if (!statSync(resolved.path).isFile()) problems.push(`server ${JSON.stringify(name)}: command ${resolved.path} is not a file`);
        else entry.executable = (statSync(resolved.path).mode & 0o111) !== 0;
      }
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(value => typeof value !== 'string'))) problems.push(`server ${JSON.stringify(name)} args must be an array of strings`);
      if (server.env !== undefined && (typeof server.env !== 'object' || server.env === null || Array.isArray(server.env) || Object.values(server.env).some(value => typeof value !== 'string'))) problems.push(`server ${JSON.stringify(name)} env must map names to strings`);
      for (const key of Object.keys(server.env ?? {})) if (RESERVED_ENV.includes(key)) problems.push(`server ${JSON.stringify(name)} env must not override ${key}`);
      if (server.cwd !== undefined && (typeof server.cwd !== 'string' || !CWD_PATTERN.test(server.cwd))) problems.push(`server ${JSON.stringify(name)} cwd must be plugin-relative`);
    } else if (server.type === 'streamable-http' || server.type === 'sse') {
      if (typeof server.url !== 'string' || !server.url) problems.push(`server ${JSON.stringify(name)} url is required`);
    } else {
      problems.push(`server ${JSON.stringify(name)} type must be stdio, streamable-http or sse`);
    }
    servers.push(entry);
  }
  return { ok: problems.length === 0, servers, problems };
}

/** Locate the plugin root from a runtime directory (repo checkout or packaged). */
export function findPluginRoot(start) {
  for (const candidate of [start, resolve(start, 'plugin'), resolve(start, '..')]) {
    if (existsSync(resolve(candidate, 'plugin.json')) && existsSync(resolve(candidate, 'mcp.json'))) return candidate;
  }
  return null;
}

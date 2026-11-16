#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile, lstat, chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AGENT_TOOLS } from '../src/agent-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !args[1]) {
  throw new Error('Use node scripts/build-plugin.mjs --out /absolute/new/share-folder');
}
const destination = resolve(args[1]);
try { await lstat(destination); throw new Error('Build destination exists; choose a new path'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const archive = `${destination}.tar.gz`;
try { await lstat(archive); throw new Error('Archive already exists; choose a new path'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'plugin/plugin.json'), 'utf8'));
if (manifest.name !== 'herdr-codex' || manifest.version !== pkg.version ||
    manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
  throw new Error('Plugin/package identity or version differs');
}
const plugin = join(destination, 'plugins/herdr-codex');
await mkdir(plugin, { recursive: true });
await cp(join(root, 'plugin'), plugin, { recursive: true, dereference: false, errorOnExist: true });
await mkdir(join(plugin, 'runtime/src'), { recursive: true });
const sources = (await readdir(join(root, 'src'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && /\.(mjs|py)$/.test(entry.name));
for (const entry of sources) await cp(join(root, 'src', entry.name), join(plugin, 'runtime/src', entry.name));
// Deterministic, source-only qualification harnesses ship with the runtime.
// No private test state, binaries, model calls or arbitrary test tree is copied.
await mkdir(join(plugin,'runtime/scripts'),{recursive:true});
await mkdir(join(plugin,'runtime/tests/fixtures'),{recursive:true});
for(const name of ['test-native-wakes.mjs','test-native-delegation.mjs','test-native-adoption.mjs','test-desk-runtime-native.mjs'])
  await cp(join(root,'scripts',name),join(plugin,'runtime/scripts',name));
for(const name of ['native-agent.mjs','native-delegate-agent.mjs','native-adoption-agent.mjs'])
  await cp(join(root,'tests/fixtures',name),join(plugin,'runtime/tests/fixtures',name));
await writeFile(join(plugin, 'runtime/package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines,
  description: pkg.description, license: pkg.license, bin: pkg.bin,
}, null, 2) + '\n');
await mkdir(join(plugin, 'docs'), { recursive: true });
for (const file of ['THIRD-PARTY.md', 'QUICKSTART.md', 'recipe-catalog.md', 'troubleshooting.md', 'agent-tools.md', 'native-adoption.md','native-capabilities.md','native-qualification.md','desk-template.md', 'general-desks.md', 'recipes.md', 'desks.md', 'delegation.md', 'configuration.md', 'config.example.json', 'profile.example.json', 'review-packets.md', 'revision-reviews.md', 'compaction-live-qualification.md']) {
  await cp(join(root, 'docs', file), join(plugin, 'docs', file), { errorOnExist: true });
}
// The source checkout keeps the dormant compaction example under `recipes/compaction/`,
// but the artifact ships the same four assets under `examples/compaction/` (alongside the
// Desk starters). Rewrite the catalog's relative links so both layouts are internally valid
// and the packaged document never points at a path that does not exist in the artifact.
{
  const catalogPath = join(plugin, 'docs/recipe-catalog.md');
  const catalog = await readFile(catalogPath, 'utf8');
  const rewritten = catalog.replaceAll('../recipes/compaction/', '../examples/compaction/');
  if (/\.\.\/recipes\/compaction\//.test(rewritten)) {
    throw new Error('Packaged recipe catalog still references the source-only recipes/compaction layout');
  }
  await writeFile(catalogPath, rewritten);
}
await cp(join(root,'examples/desks'),join(plugin,'examples/desks'),{recursive:true,dereference:false,errorOnExist:true});
// Public-source licensing/contribution documents travel with the plugin so a recipient has
// the MIT terms and the security/contribution policy in the same folder.
for (const file of ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md']) {
  await cp(join(root, file), join(plugin, file), { errorOnExist: true });
}
// Ship the bounded-compaction recipe as a DOCUMENTED EXAMPLE only. Exactly the four
// reviewed assets are packaged (no fixture tree). The example assets are NOT copied
// into a durable runtime snapshot and are NOT activated: the adapter modules already
// require a caller-supplied absolute `recipePath`, so live qualification and explicit
// durable asset selection are still required.
const compactionExampleAssets = [
  'recipe.yaml',
  'schema/summary-candidate.schema.json',
  'lib/param-encode.mjs',
  'integration-contract.md',
];
await mkdir(join(plugin, 'examples/compaction'), { recursive: true });
for (const asset of compactionExampleAssets) {
  const target = join(plugin, 'examples/compaction', asset);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, 'recipes/compaction', asset), target, { errorOnExist: true });
}
for (const asset of compactionExampleAssets) {
  await lstat(join(plugin, 'examples/compaction', asset))
    .catch(() => { throw new Error(`Missing expected compaction example asset: examples/compaction/${asset}`); });
}
await chmod(join(plugin, 'scripts/herdr-codex.sh'), 0o755);
await chmod(join(plugin, 'scripts/herdr-agents.sh'), 0o755);
await mkdir(join(destination, '.agents/plugins'), { recursive: true });
await writeFile(join(destination, '.agents/plugins/marketplace.json'), JSON.stringify({
  name: 'herdr-codex-local', interface: { displayName: 'Herdr–Codex local' },
  plugins: [{ name: 'herdr-codex', source: { source: 'local', path: './plugins/herdr-codex' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
}, null, 2) + '\n');
await writeFile(join(destination, 'README.md'), `# Herdr–Codex ${pkg.version}\n\nThis macOS-first package lets the existing Codex chat operate native Herdr workers.\nIt includes skills and the integration runtime. It excludes native binaries,\ncredentials, model servers and private state.\n\nStart with the recipient quickstart at plugins/herdr-codex/docs/QUICKSTART.md. It lists\nsupported prerequisites and explains setup with your own absolute paths, approved\ncredential file and existing Codex chat UUIDs. The recipe catalog\n(plugins/herdr-codex/docs/recipe-catalog.md) covers three optional Desk recipe starters\nand a dormant opt-in compaction example; troubleshooting, upgrade/rollback and\nlimitations are in plugins/herdr-codex/docs/troubleshooting.md. No recurring automation\nis enabled.\n\nAsk Codex to install this folder's local marketplace and configure Herdr–Codex.\nThe installed CLI supports:\n\n\`\`\`sh\ncodex plugin marketplace add /absolute/path/to/this/folder --json\ncodex plugin add herdr-codex@herdr-codex-local --json\n\`\`\`\n\nThen use the setup skill. See plugins/herdr-codex/docs/configuration.md for the full\nconfiguration contract. A real worker message received after a Codex turn ends is\nrequired to qualify idle-chat wake on this host; a queue receipt alone does not prove\nit. Other platforms are currently unsupported. No scheduled polling jobs are\ninstalled. Use the desk's one shared Desk space for related work.\n\nThis package is released under the MIT License (see plugins/herdr-codex/LICENSE). Bundled\nthird-party notices, including the js-yaml MIT notice, are in\nplugins/herdr-codex/docs/THIRD-PARTY.md. Contribution and security policies are in\nplugins/herdr-codex/CONTRIBUTING.md and plugins/herdr-codex/SECURITY.md.\n`);

async function inventory(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error(`Plugin must not contain symlinks: ${path}`);
    if (item.isDirectory()) files.push(...await inventory(path));
    else if (item.isFile()) files.push(path);
    else throw new Error(`Unexpected packaged file type: ${path}`);
  }
  return files.sort();
}
// YAML is permitted only for these exact, hand-reviewed example files. This replaces
// the former directory-wide `examples/desks` allowance so a new YAML file cannot ship
// without an explicit decision here.
const yamlAllowlist = new Set([
  'plugins/herdr-codex/examples/compaction/recipe.yaml',
  'plugins/herdr-codex/examples/desks/coding/automations/coding-on-request.yaml',
  'plugins/herdr-codex/examples/desks/coding/recipes/coding-review/recipe.yaml',
  'plugins/herdr-codex/examples/desks/operations/automations/operations-daily.yaml',
  'plugins/herdr-codex/examples/desks/operations/recipes/operations-review/recipe.yaml',
  'plugins/herdr-codex/examples/desks/research/automations/research-new-question.yaml',
  'plugins/herdr-codex/examples/desks/research/recipes/research-brief/recipe.yaml',
]);
// Extensionless files are permitted only when explicitly reviewed here.
const plainAllowlist = new Set([
  'plugins/herdr-codex/LICENSE',
]);
const entries = [];
for (const file of await inventory(destination)) {
  const path = relative(destination, file).replaceAll('\\', '/');
  const qualificationFixture=/^plugins\/herdr-codex\/runtime\/tests\/fixtures\/native-(agent|delegate-agent|adoption-agent)\.mjs$/.test(path);
  if ((!qualificationFixture&&/(^|\/)(node_modules|tests?|__pycache__|state|\.secrets|\.git)(\/|$)/.test(path)) ||
      /\.(sqlite|db|log|pyc|tgz)$/.test(path)) throw new Error(`Private/generated content in artifact: ${path}`);
  if (!/\.(md|json|sh|mjs|py)$/.test(path) && !yamlAllowlist.has(path) && !plainAllowlist.has(path)) throw new Error(`Unexpected binary or file extension in artifact: ${path}`);
  const bytes = await readFile(file), text = bytes.toString('utf8');
  if (/\/Users\/paulsmith\b|CODEX AS MANAGER|https:\/\/[^\s"']*modal\.direct/i.test(text) ||
      /\bsk-[A-Za-z0-9_-]{24,}\b/.test(text)) {
    throw new Error(`Private installation detail or embedded credential pattern in artifact: ${path}`);
  }
  if (path.endsWith('.md')) {
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = resolve(dirname(file), target);
      if (!resolved.startsWith(`${destination}/`)) throw new Error(`Document link escapes artifact: ${path} -> ${target}`);
      await lstat(resolved).catch(() => { throw new Error(`Broken packaged document link: ${path} -> ${target}`); });
    }
  }
  entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const help = execFileSync('/bin/sh', [join(plugin, 'scripts/herdr-codex.sh'), 'help'], {
  encoding: 'utf8', env: { ...process.env, HERDR_CODEX_NODE: process.execPath },
});
if (!help.includes('message reply') || !help.includes('native <all hc arguments')) throw new Error('Packaged CLI help check failed');
const mcpOutput = execFileSync('/bin/sh', [join(plugin, 'scripts/herdr-agents.sh')], {
  encoding: 'utf8', env: { ...process.env, HERDR_CODEX_NODE: process.execPath },
  input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-check', version: '1' } } }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
}).trim().split('\n').map(line => JSON.parse(line));
// Derive the expected tool surface from the single exported source of truth so
// the packaged artifact is never gated on a hand-maintained count. The packaged
// MCP discovery must return exactly the AGENT_TOOLS name set: no missing tools,
// no duplicate names and no unexpected extras.
const expectedToolNames = AGENT_TOOLS.map(tool => tool.name);
if (new Set(expectedToolNames).size !== expectedToolNames.length) throw new Error('AGENT_TOOLS contains duplicate tool names');
const discoveredTools = mcpOutput.find(r => r.id === 2)?.result?.tools;
if (!Array.isArray(discoveredTools)) throw new Error('Packaged MCP tool discovery failed');
const discoveredNames = discoveredTools.map(tool => tool?.name);
const uniqueDiscovered = new Set(discoveredNames);
if (uniqueDiscovered.size !== discoveredNames.length) throw new Error('Packaged MCP tool discovery returned duplicate tool names');
const missingTools = expectedToolNames.filter(name => !uniqueDiscovered.has(name));
const unexpectedTools = [...uniqueDiscovered].filter(name => !expectedToolNames.includes(name));
if (missingTools.length || unexpectedTools.length) throw new Error(`Packaged MCP tool discovery mismatch; missing=[${missingTools.join(', ')}] unexpected=[${unexpectedTools.join(', ')}]`);
// The packaged compaction modules must import from their own runtime copy. They are
// inert on import (no config read, no activation); they only act when a caller supplies
// an absolute recipe path, so this asserts a clean module graph, not live behaviour.
for (const module of ['runtime/src/compaction-service.mjs', 'runtime/src/pi-compaction-extension.mjs']) {
  try { await import(pathToFileURL(join(plugin, module)).href); }
  catch (error) { throw new Error(`Packaged module failed to import: ${module}: ${error.message}`); }
}
await writeFile(join(destination, 'BUILD-MANIFEST.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, builtAt: new Date().toISOString(),
  checked: { fileInventory: true, privateContentScan: true, documentLinks: true, packagedCliHelp: true, packagedMcpDiscovery: true, packagedCompactionAssets: true, packagedCompactionImports: true, modelCalls: 0 }, files: entries,
}, null, 2) + '\n');
execFileSync('/usr/bin/tar', ['-czf', archive, '-C', destination, '.']);
const archiveBytes = await readFile(archive);
console.log(JSON.stringify({
  directory: destination, archive, version: pkg.version, files: entries.length + 1,
  archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  packagedCliHelp: true, packagedMcpDiscovery: true, modelCalls: 0,
}, null, 2));

import { mkdir, readFile, realpath, stat, lstat, writeFile, link, unlink, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { assertRecipePolicy, recipeParameters } from './recipes.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string without NUL`);
  }
  return value;
}

function absolute(value, label) {
  text(value, label);
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

function paths(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((p, i) => absolute(p, `${label}[${i}]`)))].sort();
}

async function plannedRealpath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await plannedRealpath(dirname(path)), basename(path));
  }
}

async function rejectLink(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Worker file must not be a symbolic link: ${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function immutableJson(path, value) {
  await rejectLink(path);
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), value)) {
      throw new Error('Worker configuration already exists with different values; use a new worker state directory');
    }
  }
}

/** Prepare native worker launch files. Does not execute programs or read credentials. */
export async function prepareWorker(worker) {
  if (!worker || worker.version !== 1) throw new TypeError('Worker version must be 1');
  if (!['pi', 'goose'].includes(worker.role)) throw new TypeError('Worker role must be pi or goose');
  const project = await realpath(absolute(worker.project, 'project'));
  if (!(await stat(project)).isDirectory()) throw new TypeError('project must be a directory');
  const stateDir = await plannedRealpath(absolute(worker.stateDir, 'stateDir'));
  const rel = relative(project, stateDir);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new TypeError('Worker state must be outside its project checkout');
  }
  const mailbox = text(worker.mailbox, 'mailbox');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(mailbox)) {
    throw new TypeError('mailbox must be a valid Herdr document name of at most 32 characters');
  }
  const config = {
    version: 1,
    id: text(worker.id, 'id'), taskId: text(worker.taskId, 'taskId'),
    name: text(worker.name, 'name'), role: worker.role, project, stateDir,
    hc: absolute(worker.hc, 'hc'),
    ...(worker.app ? { app: absolute(worker.app, 'app') } : {}),
    node: absolute(worker.node, 'node'),
    profileFile: absolute(worker.profileFile, 'profileFile'),
    packageRoot: absolute(worker.packageRoot, 'packageRoot'),
    mailbox,
    instructions: typeof worker.instructions === 'string' ? worker.instructions : '',
    readPaths: paths(worker.readPaths ?? [], 'readPaths'),
    writePaths: paths(worker.writePaths ?? (worker.role === 'pi' ? [project] : []), 'writePaths'),
  };
  // The profile is nonsecret configuration. Its credentialFile is only read by
  // the process launcher, immediately before exec, never by this preparation API.
  const profile = JSON.parse(await readFile(config.profileFile, 'utf8'));
  text(profile.model, 'profile.model');
  const endpoint = new URL(text(profile.endpoint, 'profile.endpoint'));
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new TypeError('profile.endpoint must be an HTTP(S) endpoint without credentials');
  }
  absolute(profile.credentialFile, 'profile.credentialFile');
  const python = absolute(profile.python ?? '/usr/bin/python3', 'profile.python');
  if (worker.recipe) {
    if (worker.role !== 'goose') throw new Error('Native Goose recipes require a Goose worker');
    config.recipeParameters = recipeParameters(worker.recipeParameters ?? {});
    config.recipe = assertRecipePolicy(worker.recipe, profile, config.recipeParameters, config);
    config.executionReceiptVersion = 1;
  }
  if (worker.supervisionGrant || worker.supervisionCredential) {
    if (worker.supervisionGrant?.version !== 1 || worker.supervisionCredential?.version !== 1) throw new Error('Supervisor grant and credential must both be explicitly supplied');
    const credential = worker.supervisionCredential;
    config.supervisionGrant = structuredClone(worker.supervisionGrant);
    config.supervisionCredential = { version: 1, socketPath: absolute(credential.socketPath, 'supervision socket'), credentialFile: absolute(credential.credentialFile, 'supervision credential') };
    if (config.supervisionCredential.credentialFile !== join(stateDir, 'supervision-auth.json')) throw new Error('Supervisor credential must belong to this worker');
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (config.recipe) {
    const root = join(stateDir, 'recipe');
    await rejectLink(root); await mkdir(root, { recursive: true, mode: 0o700 });
    for (const file of config.recipe.files) {
      const path = join(root, file.path);
      for (let p = dirname(path); p !== stateDir; p = dirname(p)) await rejectLink(p);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await rejectLink(path);
      try { await writeFile(path, file.content, { flag: 'wx', mode: 0o400 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; if (await readFile(path, 'utf8') !== file.content) throw new Error('Frozen recipe differs; use a new worker state directory'); }
    }
  }
  const configFile = join(stateDir, 'worker.json');
  await immutableJson(configFile, config);
  const bin = join(stateDir, 'bin');
  await rejectLink(bin);
  await mkdir(bin, { mode: 0o700, recursive: true });
  const helpers = {
    hc: `#!/bin/sh\nset -eu\nexec ${quote(config.hc)} "$@"\n`,
    'herdr-message': `#!/bin/sh\nset -eu\nexport HERDR_CODEX_WORKER_CONFIG=${quote(configFile)}\nexec ${quote(config.node)} ${quote(join(config.packageRoot, 'src/message-cli.mjs'))} "$@"\n`,
  };
  if (config.supervisionGrant) helpers['herdr-supervise'] = `#!/bin/sh\nset -eu\nexport HERDR_CODEX_WORKER_CONFIG=${quote(configFile)}\nexec ${quote(config.node)} ${quote(join(config.packageRoot, 'src/supervisor-cli.mjs'))} "$@"\n`;
  for (const [name, source] of Object.entries(helpers)) {
    const file = join(bin, name);
    await rejectLink(file);
    try {
      await writeFile(file, source, { flag: 'wx', mode: 0o500 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(file, 'utf8') !== source) {
        throw new Error(`Worker helper already exists with different content: ${name}`);
      }
    }
  }
  await rejectLink(join(stateDir, 'runtime'));
  await mkdir(join(stateDir, 'runtime'), { recursive: true, mode: 0o700 });
  return {
    argv: [python, join(config.packageRoot, 'src/worker-launch.py'), configFile],
    cwd: project,
    env: { HERDR_CODEX_WORKER_CONFIG: configFile },
    stateDir,
    configFile,
    ...(config.recipe ? { recipeStartFile: join(stateDir, 'recipe-start.json'), executionMode: 'recipe', executionReceiptVersion: 1 } : {}),
  };
}

/** Release a prepared recipe only after the manager has persisted its native binding. */
export async function startRecipeWorker(worker, payload) {
  const stateDir = await realpath(absolute(worker.stateDir, 'stateDir'));
  const saved = JSON.parse(await readFile(join(stateDir, 'worker.json'), 'utf8'));
  if (!saved.recipe || saved.id !== worker.id || saved.taskId !== worker.taskId) throw new Error('Recipe gate worker identity mismatch');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Recipe start requires the assigned context payload');
  const path = join(stateDir, 'recipe-start.json'), value = { version: 1, workerId: saved.id, taskId: saved.taskId, recipeSha256: saved.recipe.sha256, payload };
  await rejectLink(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = await open(temporary, 'wx', 0o400);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
  try {
    let duplicate = false;
    try { await link(temporary, path); } catch (e) { if (e.code !== 'EEXIST') throw e; duplicate = true; }
    const directory = await open(stateDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await rejectLink(path);
    if (!isDeepStrictEqual(JSON.parse(await readFile(path, 'utf8')), value)) throw new Error('Recipe already started with a different assignment payload');
    return { started: true, duplicate, file: path, recipeSha256: saved.recipe.sha256 };
  } finally { await unlink(temporary); }
}

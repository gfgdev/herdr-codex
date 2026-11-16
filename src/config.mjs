import { readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function defaultConfigPath(home = homedir()) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Expected absolute user home');
  return join(home, '.config', 'herdr-codex', 'config.json');
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`Expected absolute ${label}`);
  }
  return resolve(value);
}

export function resolveConfigPath(explicit, { env = process.env, home = homedir() } = {}) {
  // A selected but invalid path is an error, never permission to select another
  // installation. Working-directory discovery is deliberately unsupported.
  return absolutePath(explicit ?? env.HERDR_CODEX_CONFIG ?? defaultConfigPath(home), 'config path');
}

function readConfigFile(path) {
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No Herdr–Codex configuration at ${path}. Run setup, pass --config /absolute/config.json, or set HERDR_CODEX_CONFIG.`, { cause: error });
    }
    throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected integration configuration object');
  if (config.version !== 1) throw new Error('Unsupported integration configuration version');
  return config;
}

function loadConfig(path) {
  let config = readConfigFile(path);
  let reference;
  if (Object.hasOwn(config, 'configFile')) {
    if (Object.keys(config).some(key => !['version', 'configFile'].includes(key))) {
      throw new Error('A configuration reference must contain only version and configFile');
    }
    reference = path;
    path = absolutePath(config.configFile, 'configFile reference');
    config = readConfigFile(path);
    if (Object.hasOwn(config, 'configFile')) throw new Error('Configuration reference chains are not supported');
  }
  for (const key of ['stateDir', 'hc', 'app', 'codex', 'profileFile', 'node']) {
    absolutePath(config[key], key);
  }
  return { ...config, path, ...(reference ? { configReference: reference } : {}) };
}

export function readConfig(explicit, options) {
  const config = loadConfig(resolveConfigPath(explicit, options));
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  return { ...config, registryDoc: `cx-reg-${digest(config.stateDir).slice(0, 20)}` };
}

/** Select an existing installation without copying settings, credentials or state. */
export function installConfigReference(target, { home = homedir() } = {}) {
  const targetPath = absolutePath(target, 'config path');
  const config = loadConfig(targetPath);
  if (config.configReference) throw new Error('Point directly to the installation configuration, not another reference');
  const path = defaultConfigPath(home);
  if (path === targetPath) return { path, configFile: targetPath, created: false };
  const reference = { version: 1, configFile: targetPath };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${JSON.stringify(reference, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readConfigFile(path);
    if (Object.keys(existing).length !== 2 || existing.version !== 1 || existing.configFile !== targetPath) {
      throw new Error(`A different configuration already exists at ${path}; inspect it before deliberately replacing the user default.`);
    }
    return { path, configFile: targetPath, created: false };
  }
  return { path, configFile: targetPath, created: true };
}
export function dbPath(config) { return join(config.stateDir, 'manager.sqlite'); }
export function safeId(value, name = 'id') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value ?? '')) throw new Error(`Invalid ${name}`);
  return value;
}

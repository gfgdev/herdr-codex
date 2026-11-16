import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';

const MAX_TEMPLATE_BYTES = 256 * 1024;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const KEYS = ['version', 'name', 'description', 'harness', 'scope', 'instructions'];
const definitions = [
  { name: 'explorer', description: 'Trace a code path or failure and return evidence before implementation.', harness: 'pi', scope: 'read-only',
    instructions: 'Trace the relevant source and tests. Identify concrete entry points, dependencies and failure causes with file references. Distinguish executed observations from hypotheses. Keep the project read-only and return a focused answer that lets the manager decide the next step.' },
  { name: 'implementer', description: 'Implement a scoped change and verify its behavior.', harness: 'pi', scope: 'write',
    instructions: 'Own the assigned implementation within the granted writable scope. Preserve unrelated changes. Inspect the existing behavior, make a coherent change, and run checks that exercise the requested result. Report changed files, actual commands and outcomes, and unresolved limitations. Consult an assigned colleague when it helps; no fixed review sequence is required.' },
  { name: 'reviewer', description: 'Independently review changes for correctness and missing verification.', harness: 'goose', scope: 'read-only',
    instructions: 'Inspect actual source, changes and tests independently. Prioritize reproducible correctness problems and meaningful verification gaps. Cite locations and evidence, and distinguish findings from suggestions. Use private scratch space for probes and keep the project read-only. Do not claim checks that were not run or treat another agent\'s conclusions as verified facts.' },
  { name: 'tester', description: 'Exercise specified behavior and report reproducible failures.', harness: 'pi', scope: 'read-only',
    instructions: 'Exercise the assigned behavior with existing tests and focused independent probes. Capture setup, command, exit status and observed outcome. Keep project files unchanged; use private scratch space for generated inputs and outputs. Report when a test requires writable project state rather than changing permissions or silently skipping it. Separate a real failure from a broken test setup.' },
  { name: 'investigator', description: 'Investigate an open question and synthesize a supported recommendation.', harness: 'goose', scope: 'read-only',
    instructions: 'Investigate the assigned question using relevant project evidence and available authorized sources. Compare plausible explanations, state uncertainties, and produce a concise recommendation with supporting references. Keep project files read-only. Spend inference on interpretation and synthesis; use ordinary tools directly for routine collection.' },
];
const BUILTINS = new Map(definitions.map(template => [template.name, Object.freeze({ version: 1, ...template })]));
const clone = value => JSON.parse(JSON.stringify(value));

function nameOf(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('Template name must be 1–64 lowercase letters, digits or hyphens, starting with a letter');
  return name;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} must be nonempty text without NUL`);
  return value;
}

export function validateTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Template must be an object');
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) throw new TypeError(`Unknown template field: ${key}`);
  if (value.version !== 1) throw new TypeError('Template version must be 1');
  if (!['pi', 'goose'].includes(value.harness)) throw new TypeError('Template harness must be pi or goose');
  if (!['read-only', 'write'].includes(value.scope)) throw new TypeError('Template scope must be read-only or write');
  return { version: 1, name: nameOf(value.name), description: text(value.description, 'description'),
    harness: value.harness, scope: value.scope, instructions: text(value.instructions, 'instructions') };
}

function assertNoLinks(path, { missing = false } = {}) {
  for (let current = path; ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new TypeError(`Template paths must not contain symbolic links: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT' || !missing) throw error; }
    if (dirname(current) === current) break;
  }
}

function directory(templateDir, { create = false } = {}) {
  if (templateDir === undefined) return null;
  text(templateDir, 'templateDir');
  if (!isAbsolute(templateDir)) throw new TypeError('templateDir must be an absolute path');
  const path = resolve(templateDir);
  assertNoLinks(path, { missing: true });
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  try { if (!lstatSync(path).isDirectory()) throw new TypeError('templateDir must be a directory'); }
  catch (error) { if (error.code !== 'ENOENT' || create) throw error; }
  return path;
}

function readTemplate(file) {
  const path = resolve(text(file, 'template file'));
  assertNoLinks(path);
  if (!lstatSync(path).isFile()) throw new TypeError('Template source must be a regular file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TypeError('Template source must be a regular file');
    if (stat.size >= MAX_TEMPLATE_BYTES) throw new RangeError(`Template must be smaller than ${MAX_TEMPLATE_BYTES} bytes`);
    bytes = readFileSync(fd);
    if (bytes.length >= MAX_TEMPLATE_BYTES) throw new RangeError(`Template must be smaller than ${MAX_TEMPLATE_BYTES} bytes`);
  } finally { closeSync(fd); }
  return validateTemplate(JSON.parse(decoder.decode(bytes)));
}

export function getTemplate(name, { templateDir } = {}) {
  nameOf(name);
  if (BUILTINS.has(name)) return clone(BUILTINS.get(name));
  const dir = directory(templateDir);
  if (!dir) throw new Error(`Unknown template: ${name}`);
  let template;
  try { template = readTemplate(join(dir, `${name}.json`)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Unknown template: ${name}`, { cause: error }); throw error; }
  if (template.name !== name) throw new TypeError('Template filename and declared name differ');
  return template;
}

export function listTemplates({ templateDir } = {}) {
  const templates = [...BUILTINS.values()].map(clone);
  const dir = directory(templateDir);
  let entries = [];
  if (dir) {
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const name = nameOf(entry.name.slice(0, -5));
    if (BUILTINS.has(name)) throw new Error(`Custom template cannot shadow built-in template: ${name}`);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new TypeError(`Template must be a regular file: ${entry.name}`);
    templates.push(getTemplate(name, { templateDir: dir }));
  }
  return templates.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Install an explicit reusable instruction file without overwriting any template. */
export function installTemplate(file, { templateDir } = {}) {
  const template = readTemplate(file);
  if (BUILTINS.has(template.name)) throw new Error(`Cannot replace built-in template: ${template.name}`);
  if (templateDir === undefined) throw new TypeError('Installing a template requires templateDir');
  const dir = directory(templateDir, { create: true });
  const path = join(dir, `${template.name}.json`);
  const contents = JSON.stringify(template, null, 2) + '\n';
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, contents); } finally { closeSync(fd); }
    return { template, path, created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readTemplate(path);
    if (JSON.stringify(existing) !== JSON.stringify(template)) throw new Error(`A different template already exists: ${template.name}; choose a new name`);
    return { template: existing, path, created: false };
  }
}

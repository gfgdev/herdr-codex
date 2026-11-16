import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function canonicalProject(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) {
    throw new TypeError('Project must be an explicit absolute directory path');
  }
  const project = realpathSync(value);
  if (!statSync(project).isDirectory()) throw new TypeError('Project must be a directory');
  return project;
}

export function localSpace(space) { return space.machine == null || space.machine === ''; }

export function assertWorkerTask(worker, task) {
  if (!task || task.id !== worker.taskId) throw new Error('Unknown task');
  for(const key of ['deskId','deskProjectId','deskWorkId','deskJobId','deskRunId','deskStepId'])if((worker[key]??null)!==(task[key]??null))throw new Error('Worker desk binding must match its registered task');
  if (typeof worker.project !== 'string' || task.project !== worker.project) {
    throw new Error('Worker project must match its registered task');
  }
}

/**
 * Verify that a native terminal is still the original process launched/adopted for
 * this worker. `allowFinished` relaxes ONLY the live-state requirement, for read-only
 * history and delayed stop confirmation. Every other immutable identity attribute
 * (task/desk labels, address, pid, launch program and creation time) is still checked,
 * so a different process that reuses the terminal address cannot be accepted.
 */
export function assertNativeWorker(worker, native, { allowFinished = false } = {}) {
  const stateOk = native?.state === 'live' || (allowFinished && native?.state === 'finished');
  const addressOk = typeof worker?.terminalId !== 'string' || native?.address == null || native.address === worker.terminalId;
  const argvOk = !worker?.launchArgv?.length || native?.argv == null || JSON.stringify(native.argv) === JSON.stringify(worker.launchArgv);
  const createdOk = worker?.launchIdentity?.created_ms == null || native?.created_ms == null || native.created_ms === worker.launchIdentity.created_ms;
  if (!worker?.id || !worker?.taskId || !worker?.terminalId || !stateOk || !addressOk || !argvOk || !createdOk ||
      native.cwd !== worker.project || native.labels?.['codex.worker'] !== worker.id ||
      native.labels?.['codex.task'] !== worker.taskId || (worker.deskId&&(native.labels?.['codex.desk']!==worker.deskId||native.labels?.['codex.desk-project']!==worker.deskProjectId)) || !localSpace(native) ||
      (worker.launchResult?.pid && native.pid !== worker.launchResult.pid)) {
    throw new Error('Worker native identity/project/task changed; inspect the original terminal before proceeding');
  }
  if(worker.adoption){
    const expected=worker.adoption.nativeIdentity;
    if(native.address!==expected.address||native.pid!==expected.pid||(native.created_ms??null)!==expected.created_ms||
      JSON.stringify(native.argv??[])!==JSON.stringify(expected.argv)||(native.parent??null)!==expected.parent||
      !Object.entries(worker.adoption.labels).every(([key,value])=>native.labels?.[key]===value))
      throw new Error('Adopted native process identity changed; no input was sent');
  }
  return native;
}

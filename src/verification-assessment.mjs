/**
 * Read-only verification assessment for an already-owned Desk command.
 *
 * This module certifies one thing only: a single frozen Desk command finished,
 * its host-observed execution exit was zero, and a caller-supplied trusted
 * `captureRevision` baseline for the command's registered project still
 * verifies byte-for-byte against disk. It never launches, signals, polls,
 * writes, acknowledges, accepts or retires anything, and it makes no model
 * call. It issues at most one bounded native observation request.
 *
 * Exit 0 of the assessed command proves only that the declared command check
 * passed. It does not prove business correctness, and a revision match proves
 * only that the selected scopes are unchanged since the baseline -- never that
 * someone edited and later restored a file, and never that any assertion about
 * the work is true.
 *
 * The baseline-before-execution ordering is a CALLER CONTRACT. This service has
 * no temporal proof of when the baseline was captured; it trusts the caller to
 * supply a `captureRevision` result taken before the command ran. Do not read a
 * pass here as proof of ordering.
 *
 * Command identity comes from the frozen worker record plus the execution
 * receipt written by the command worker, never from caller prose. Receipt
 * identity, revision rules and routing identity are reused from the existing
 * primitives (`WorkflowRuns.executionReceipt` / `verifyFinished`,
 * `evidence.verifyRevision`, `routing.assertWorkerTask` / `assertNativeWorker`);
 * none are re-derived here.
 *
 * A pass requires both a successful receipt AND an explicitly observed zero
 * native exit. Ownership, the frozen run/step/worker binding, and the revision
 * are all (re-)read AFTER the single awaited observation, immediately before
 * any pass decision, so neither a concurrent rebind nor a project mutated
 * during the observation can be certified under stale pre-await facts.
 */
import {verifyRevision} from './evidence.mjs';
import {assertNativeWorker, assertWorkerTask} from './routing.mjs';
import {WorkflowRuns} from './desk-runs.mjs';

export const ASSESSMENT_VERDICT = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  PENDING: 'pending',
  UNCERTAIN: 'uncertain',
});

export const ASSESSMENT_LIMITS = Object.freeze({
  maxChangedPaths: 256,
  maxArgv: 64,
  maxArgLength: 4096,
  maxReasonLength: 512,
  maxErrorLength: 512,
});

function boundedText(value, limit) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function boundedArgv(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.slice(0, ASSESSMENT_LIMITS.maxArgv)
    .map(argument => boundedText(argument, ASSESSMENT_LIMITS.maxArgLength));
}

function boundedError(error) {
  return {
    name: boundedText(error?.name ?? 'Error', 128),
    message: boundedText(error?.message ?? String(error), ASSESSMENT_LIMITS.maxErrorLength),
    code: typeof error?.code === 'string' ? boundedText(error.code, 128) : null,
  };
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Verification assessment requires an explicit ${label}`);
  return value;
}

function observationOf(native) {
  return {
    state: typeof native.state === 'string' ? native.state : null,
    exitCode: Number.isInteger(native.exit_code) ? native.exit_code : null,
  };
}

export class VerificationAssessment {
  constructor({store, config, rpc, runs = null} = {}) {
    if (!store || typeof store.worker !== 'function' || typeof store.task !== 'function') {
      throw new Error('Verification assessment requires a Store');
    }
    if (!config || typeof config !== 'object') {
      throw new Error('Verification assessment requires a resolved config object');
    }
    if (!rpc || typeof rpc.request !== 'function') {
      throw new Error('Verification assessment requires an rpc client exposing request()');
    }
    if (runs !== null && (typeof runs.get !== 'function' || typeof runs.executionReceipt !== 'function' || typeof runs.verifyFinished !== 'function')) {
      throw new Error('Verification assessment runs dependency must be a WorkflowRuns instance');
    }
    this.store = store;
    this.config = config;
    this.rpc = rpc;
    this.runs = runs ?? new WorkflowRuns({store, config, rpc});
  }

  /**
   * Resolve the owner, frozen worker and registered task from stored state.
   * Manager chat and worker/task ownership are checked BEFORE any report,
   * path or native evidence is read. Every failure here is a caller/contract
   * error, not a verification verdict.
   */
  ownership({deskId, runId, stepId, workerId, ownerThread}) {
    requireId(deskId, 'desk id');
    requireId(runId, 'workflow run id');
    requireId(stepId, 'workflow step id');
    requireId(workerId, 'frozen worker id');
    requireId(ownerThread, 'owning manager chat id');

    const run = this.runs.get(deskId, runId);
    if (!run) throw new Error('Unknown workflow run for assessment');
    if (run.deskId !== deskId) throw new Error('Assessment run belongs to a different desk');
    if (run.ownerThread !== ownerThread) throw new Error('Assessment requires the exact owning manager chat');

    const step = run.steps?.[stepId];
    if (!step || step.workerId !== workerId) throw new Error('Assessment worker is not the frozen worker for that run step');

    const worker = this.store.worker(workerId);
    if (!worker) throw new Error('Unknown frozen worker for assessment');
    const task = this.store.task(worker.taskId);
    if (!task) throw new Error('Assessment worker has no registered task');

    assertWorkerTask(worker, task);
    if (task.threadId !== ownerThread) throw new Error('Assessment task belongs to a different manager chat');
    if (worker.deskRunId !== runId || worker.deskStepId !== stepId) throw new Error('Assessment worker is not bound to the frozen run step');
    if (worker.executionKind !== 'command') throw new Error('Verification assessment supports frozen command executions only');

    return {run, step, worker, task, ownerThread};
  }

  /**
   * Verify the caller baseline against disk once, without trusting any claimed
   * hash. Any structural or capture fault is reported as unverifiable rather
   * than as a match.
   */
  revision(worker, baseline) {
    let verified;
    try {
      verified = verifyRevision(worker.project, baseline);
    } catch (error) {
      return {
        project: worker.project,
        baselineSha256: typeof baseline?.sha256 === 'string' ? baseline.sha256 : null,
        actualSha256: null,
        match: false,
        consistent: false,
        changedPaths: [],
        changedPathsTruncated: false,
        error: boundedError(error),
      };
    }
    const changed = Array.isArray(verified.changed_paths) ? verified.changed_paths : [];
    const limit = ASSESSMENT_LIMITS.maxChangedPaths;
    return {
      project: worker.project,
      baselineSha256: typeof baseline?.sha256 === 'string' ? baseline.sha256 : null,
      actualSha256: typeof verified.actual_sha256 === 'string' ? verified.actual_sha256 : null,
      match: verified.match === true,
      consistent: verified.revision_consistent === true,
      changedPaths: changed.slice(0, limit).map(path => boundedText(path, 1024)),
      changedPathsTruncated: changed.length > limit,
      error: verified.error ? boundedError(verified.error) : null,
    };
  }

  /**
   * Immutable authority fingerprint for the resolved run/step/worker binding.
   * Re-read after every await: a concurrent rebind must not be certified under
   * the authority resolved before the observation.
   */
  static #authority(worker, run, step) {
    return JSON.stringify([
      worker.id,
      worker.taskId,
      worker.terminalId,
      worker.command?.fingerprint ?? null,
      worker.deskRunId,
      worker.deskStepId,
      worker.project,
      run.id,
      run.ownerThread,
      step.workerId,
    ]);
  }

  static #result(base, verdict, reason, patch) {
    return Object.freeze({
      ...base,
      verdict,
      reason: boundedText(reason, ASSESSMENT_LIMITS.maxReasonLength),
      ...(patch.observation !== undefined ? {observation: patch.observation} : {}),
      ...(patch.execution !== undefined ? {execution: patch.execution} : {}),
      ...(patch.revision !== undefined ? {revision: patch.revision} : {}),
    });
  }

  /**
   * Assess one frozen command. The caller supplies the exact manager chat, the
   * frozen run/step/worker identity, and the trusted pre-run baseline.
   */
  async assess(input = {}) {
    const {run, step, worker, ownerThread} = this.ownership(input);

    const baseline = input.baseline;
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
      throw new Error('Verification assessment requires a caller-supplied captureRevision baseline');
    }
    if (baseline.project !== worker.project) {
      throw new Error('Assessment baseline was captured for a different project than the frozen command');
    }

    const base = {
      version: 1,
      deskId: run.deskId,
      runId: run.id,
      stepId: step.id,
      workerId: worker.id,
      taskId: worker.taskId,
      chatId: ownerThread,
      command: {
        kind: 'command',
        fingerprint: worker.command?.fingerprint ?? null,
        argv: boundedArgv(worker.command?.argv),
        project: worker.project,
      },
      limits: ASSESSMENT_LIMITS,
    };

    // Exactly one bounded native observation call (never a poll or wait). This
    // await yields control, so NO authority or revision fact may be trusted from
    // before it.
    let native = null;
    if (typeof worker.terminalId === 'string' && worker.terminalId.length > 0) {
      try {
        native = await this.rpc.request('terminal.get', {terminal: worker.terminalId});
      } catch (error) {
        return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'native-observation-failed', {
          observation: {state: null, exitCode: null, error: boundedError(error)},
          execution: null,
          revision: this.revision(worker, baseline),
        });
      }
    }

    // Re-read the exact owner and frozen run/step/worker binding after the
    // await. A concurrent rebind (or a replacement worker on the same run step)
    // must not be certified under the authority resolved before the await.
    let current;
    try {
      current = this.ownership(input);
    } catch {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'ownership-changed', {
        observation: native === null ? null : observationOf(native), execution: null, revision: null,
      });
    }
    if (VerificationAssessment.#authority(worker, run, step) !== VerificationAssessment.#authority(current.worker, current.run, current.step)) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'ownership-changed', {
        observation: native === null ? null : observationOf(native), execution: null, revision: null,
      });
    }
    const authoritative = current.worker;

    const observation = native === null ? null : observationOf(native);

    if (native === null) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'worker-never-launched', {
        observation: null, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    // A live process means the declared command has not finished. Always
    // pending, regardless of revision state.
    if (native.state === 'live') {
      try {
        assertNativeWorker(authoritative, native);
      } catch (error) {
        return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'native-identity-changed', {
          observation: {...observation, error: boundedError(error)}, execution: null, revision: this.revision(authoritative, baseline),
        });
      }
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.PENDING, 'command-still-running', {
        observation, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    if (native.state !== 'finished') {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'native-state-unknown', {
        observation, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    // Finished process: re-verify its immutable launch identity before reading
    // any receipt, so a replacement process on the same address cannot count.
    try {
      this.runs.verifyFinished(authoritative, native);
    } catch (error) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'native-identity-changed', {
        observation: {...observation, error: boundedError(error)}, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    // Execution facts come only from the frozen receipt; identity mismatches
    // throw and can never become a pass.
    let receipt = null;
    try {
      receipt = this.runs.executionReceipt(authoritative);
    } catch (error) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'execution-receipt-mismatch', {
        observation: {...observation, error: boundedError(error)}, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    if (!receipt) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'execution-receipt-missing', {
        observation, execution: null, revision: this.revision(authoritative, baseline),
      });
    }

    const execution = {
      exit: {
        code: Number.isInteger(receipt.exit?.code) ? receipt.exit.code : null,
        signal: Number.isInteger(receipt.exit?.signal) ? receipt.exit.signal : null,
      },
      success: receipt.success === true,
      receiptSha256: typeof receipt.sha256 === 'string' ? receipt.sha256 : null,
    };

    // Re-read the revision HERE, after the observed host state and the receipt
    // identity are known and immediately before any pass decision. A process
    // that mutates the project while the observation is in flight can no longer
    // be certified against a stale baseline match.
    const revision = this.revision(authoritative, baseline);

    // The receipt and the host must agree on the observed exit code.
    if (observation.exitCode !== null && execution.exit.code !== null && observation.exitCode !== execution.exit.code) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'exit-evidence-disagreement', {
        observation, execution, revision,
      });
    }

    // A nonzero exit (or death by signal) is a failure even when the selected
    // bytes are unchanged: a matched revision never rescues a failed command.
    if (!execution.success) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.FAILED, 'command-exit-nonzero', {
        observation, execution, revision,
      });
    }

    // A successful receipt is not enough. A pass requires an explicitly
    // observed zero native exit; a missing or non-integer host exit is
    // unverifiable, and a nonzero host exit contradicts the receipt.
    if (observation.exitCode === null) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'native-exit-unobserved', {
        observation, execution, revision,
      });
    }
    if (observation.exitCode !== 0) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'exit-evidence-disagreement', {
        observation, execution, revision,
      });
    }

    // Execution passed. The revision must now verify against disk.
    if (revision.error) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'revision-unverifiable', {
        observation, execution, revision,
      });
    }
    if (!revision.consistent) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'revision-manifest-inconsistent', {
        observation, execution, revision,
      });
    }
    if (!revision.match) {
      return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.UNCERTAIN, 'revision-drift', {
        observation, execution, revision,
      });
    }

    return VerificationAssessment.#result(base, ASSESSMENT_VERDICT.PASSED, 'declared-command-check-passed-and-baseline-unchanged', {
      observation, execution, revision,
    });
  }
}

export default VerificationAssessment;

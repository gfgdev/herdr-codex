#!/usr/bin/env node
/**
 * Real-Pi-session boundary proof for the bounded compaction adapter.
 *
 * SCOPE (bounded slice)
 * ---------------------
 * This script drives a GENUINE `@earendil-works/pi-coding-agent` `AgentSession`:
 * a disposable synthetic `SessionManager`, the real `DefaultResourceLoader` inline
 * extension factory surface, and the real `AgentSession.compact()` code path. It proves
 * two facts against that real session:
 *
 *   1. COMMIT: our `session_before_compact` adapter returns a candidate and Pi actually
 *      APPENDS a `CompactionEntry` to the session log, then reconstructs context with the
 *      summary in place and the summarized history omitted.
 *   2. CANCEL: when the adapter returns `{ cancel: true }` (here via Pi's real
 *      `session.abortCompaction()` racing an in-flight runner), Pi appends NOTHING; the
 *      session log and entries are byte-for-byte unchanged.
 *
 * WHAT THIS IS NOT
 * ----------------
 * The recipe runner injected here is a DETERMINISTIC, IN-PROCESS STUB. It is NOT a live
 * model, does not call Goose, and does not exercise prompt assembly or provider
 * behaviour. This is therefore NOT live model qualification; it is a boundary proof of
 * the append / cancel contract. The next slice replaces the stub runner with the real
 * Goose recipe runner.
 *
 * NO network, NO model, NO credentials: the session is synthetic and bounded, and the
 * only external artefact is a disposable JSONL session file under the scratch dir.
 *
 * USAGE
 *   node scripts/qualify-compaction-session.mjs [--json] [--keep]
 *
 * Exit code 0 iff both scenarios hold; non-zero (with the failing assertion on stderr)
 * otherwise. `--json` prints the full retained evidence report.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const EXTENSION_PATH = join(REPO_ROOT, "src", "pi-compaction-extension.mjs");

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Resolve the installed Pi coding-agent SDK entrypoint portably, with no hard-coded
 * machine path:
 *   1. `PI_CODING_AGENT_DIST` — explicit absolute path to the SDK dist entry, used when
 *      the SDK is not resolvable as a package (for example a checkout with no local
 *      `node_modules`).
 *   2. Normal package resolution (`import.meta.resolve`), which succeeds when the SDK is
 *      installed in the project or a parent `node_modules`.
 * If neither resolves, the caller must set `PI_CODING_AGENT_DIST` explicitly.
 */
export function resolveSdkDist() {
  const override = process.env.PI_CODING_AGENT_DIST;
  if (typeof override === "string" && override.length > 0) return override;
  try {
    return fileURLToPath(import.meta.resolve(SDK_PACKAGE));
  } catch {
    /* fall through to the explicit guidance below */
  }
  throw new Error(
    `Pi coding-agent SDK (${SDK_PACKAGE}) not found. Install it, or set PI_CODING_AGENT_DIST ` +
      `to the absolute path of its dist entry, e.g.\n` +
      `  PI_CODING_AGENT_DIST=/absolute/path/to/node_modules/${SDK_PACKAGE}/dist/index.js node scripts/qualify-compaction-session.mjs`,
  );
}

/** Import the installed SDK (see `resolveSdkDist` for how the path is chosen). */
export async function loadSdk() {
  const sdkDist = resolveSdkDist();
  return { sdkDist, sdk: await import(pathToFileURL(sdkDist).href) };
}

const RESERVE_TOKENS = 16;
const KEEP_RECENT_TOKENS = 20;

/** Deterministic stub runner. NOT live model qualification (see file header). */
function makeStubRunner({ onInvoke, gate } = {}) {
  return async function stubRunner(request, { signal } = {}) {
    if (typeof onInvoke === "function") onInvoke(request);
    if (gate) await gate(signal);
    // Echo the adapter-owned passthrough so `validateCandidate` binding checks pass, and
    // return a small, structurally valid candidate. `acceptance_inferred` must be false.
    return JSON.stringify({
      status: "ok",
      acceptance_inferred: false,
      passthrough: {
        session_identity: request.session_identity,
        input_digest: request.input_digest,
        first_kept_entry_id: request.first_kept_entry_id,
        tokens_before: request.tokens_before,
      },
      goals: ["Prove the real Pi session appends a compaction entry."],
      constraints: ["No network, no model, no credentials."],
      decisions: [],
      contradictions: [],
      completed: ["Ran a real AgentSession.compact() through the extension surface."],
      pending: [],
      evidence: [],
      uncertainty: [],
    });
  };
}

function resolveScratchRoot() {
  const candidates = [process.env.HERDR_CODEX_SCRATCH, process.env.TMPDIR, tmpdir()].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      return base;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("no writable scratch root (set HERDR_CODEX_SCRATCH or TMPDIR)");
}

/** Build a synthetic user/assistant history that `prepareCompaction` will actually cut. */
function seedHistory(sessionManager, count, tag) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const user = sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `${tag}-user-${i}: synthetic bounded turn ${i}` }],
      timestamp: Date.now() + i,
    });
    const assistant = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `${tag}-assistant-${i}: acknowledged synthetic turn ${i}` }],
      api: "test",
      provider: "test",
      model: "test-model",
      usage: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now() + i,
    });
    ids.push(user, assistant);
  }
  return ids;
}

/**
 * Build a disposable, file-backed real session with the extension registered through the
 * real `DefaultResourceLoader` inline factory surface.
 */
export async function buildFixture({ sdk, scratchDir, runner, sessionIdentity, tag, timeoutMs, maxAttempts }) {
  const cwd = join(scratchDir, "cwd");
  const agentDir = join(scratchDir, "agent");
  const sessionDir = join(scratchDir, "sessions");
  for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS } }),
    "utf8",
  );

  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;

  const observations = [];
  const { createPiCompactionExtension } = await import(pathToFileURL(EXTENSION_PATH).href);
  const adapter = createPiCompactionExtension({
    config: { session_identity: sessionIdentity, timeoutMs, maxAttempts },
    runner,
    sink: (observation) => observations.push(observation),
  });

  const factory = (pi) => {
    adapter.register(pi);
  };

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(cwd, sessionDir);
  const seededIds = seedHistory(sessionManager, 3, tag);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  const events = [];
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    model: { provider: "test", id: "test-model", contextWindow: 100000, maxTokens: 4096 },
    noTools: true,
  });
  const session = created.session;
  session.subscribe((event) => events.push(event?.type));

  const sessionFile = sessionManager.getSessionFile();
  // Baseline taken AFTER the real session finished its own startup appends
  // (e.g. `thinking_level_change`), so any later growth is attributable to compaction.
  const entriesAtStart = sessionManager.getEntries().length;

  return {
    cwd,
    agentDir,
    sessionDir,
    sessionFile,
    session,
    sessionManager,
    adapter,
    observations,
    events,
    seededIds,
    entriesAtStart,
    settingsManager,
    extensionsLoaded: created.extensionsResult?.extensions?.length ?? 0,
  };
}

function readJsonlEntries(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Scenario 1: the extension supplies a candidate and Pi COMMITS it to the session log.
 */
async function runCommitScenario({ sdk, scratchDir }) {
  let invoked = 0;
  const runner = makeStubRunner({ onInvoke: () => (invoked += 1) });
  const fixture = await buildFixture({ sdk, scratchDir, runner, sessionIdentity: "sess-commit-1", tag: "commit" });
  const { session, sessionManager, adapter, observations, events, entriesAtStart, seededIds } = fixture;

  const result = await session.compact();

  const finalEntries = sessionManager.getEntries();
  const entriesAfter = finalEntries.length;
  const appendedEntries = finalEntries.slice(entriesAtStart).map((entry) => entry.type);
  const compactionEntry = finalEntries.find((entry) => entry.type === "compaction");
  const jsonl = readJsonlEntries(fixture.sessionFile);
  const jsonlCompactions = jsonl.filter((entry) => entry.type === "compaction");
  const context = sessionManager.buildSessionContext();
  const summaryText = result?.summary ?? compactionEntry?.summary ?? "";
  const summaryMarker = summaryText.split("\n")[0];
  const reconstructedHasSummary = context.messages.some(
    (message) => message.role === "compactionSummary" && typeof message.summary === "string" && message.summary === summaryText,
  );
  const reconstructedDroppedOld = !JSON.stringify(context.messages).includes("commit-user-0");

  const committedObservation = adapter.state.lastCommitted !== null;
  const committedCodes = observations.filter((o) => o.outcome === "committed").map((o) => o.code);
  const candidateReady = observations.some((o) => o.outcome === "candidate_ready" && o.code === "candidate_ready");

  return {
    invoked,
    entriesBefore: entriesAtStart,
    entriesAfter,
    appendedEntries,
    seededCount: seededIds.length,
    compactionEntry: compactionEntry
      ? {
          id: compactionEntry.id,
          fromHook: compactionEntry.fromHook === true,
          firstKeptEntryId: compactionEntry.firstKeptEntryId,
          tokensBefore: compactionEntry.tokensBefore,
          summaryMarker,
        }
      : null,
    jsonlCompactionCount: jsonlCompactions.length,
    result: result
      ? { firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore, summaryTokens: result.summary ? result.summary.length : 0 }
      : null,
    reconstructed: { messageCount: context.messages.length, hasSummary: reconstructedHasSummary, droppedOld: reconstructedDroppedOld },
    observations,
    events,
    candidateReady,
    committedObservation,
    committedCodes,
    extensionsLoaded: fixture.extensionsLoaded,
  };
}

/**
 * Scenario 2: Pi cancels the compaction mid-flight (real `abortCompaction()`), the
 * adapter returns `{ cancel: true }`, and NOTHING is appended to the session.
 */
async function runCancelScenario({ sdk, scratchDir }) {
  let releaseGate;
  const gate = new Promise((resolveGate) => {
    releaseGate = resolveGate;
  });
  let runnerStarted;
  const started = new Promise((resolveStarted) => {
    runnerStarted = resolveStarted;
  });
  const runner = makeStubRunner({
    onInvoke: () => runnerStarted(),
    gate: async () => {
      await gate;
    },
  });

  const fixture = await buildFixture({ sdk, scratchDir, runner, sessionIdentity: "sess-cancel-1", tag: "cancel" });
  const { session, sessionManager, observations, events, entriesAtStart, sessionFile, seededIds } = fixture;

  const jsonlBefore = readJsonlEntries(sessionFile).length;
  const pending = session.compact();
  await started;
  session.abortCompaction();
  releaseGate();

  let thrown = null;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }

  const finalEntries = sessionManager.getEntries();
  const entriesAfter = finalEntries.length;
  const jsonlAfter = readJsonlEntries(sessionFile).length;

  return {
    entriesBefore: entriesAtStart,
    entriesAfter,
    appendedEntries: finalEntries.slice(entriesAtStart).map((entry) => entry.type),
    seededCount: seededIds.length,
    appended: entriesAfter !== entriesAtStart,
    jsonlBefore,
    jsonlAfter,
    jsonlAppended: jsonlAfter !== jsonlBefore,
    compactionEntries: finalEntries.filter((entry) => entry.type === "compaction").length,
    threw: Boolean(thrown),
    errorMessage: thrown ? String(thrown.message) : null,
    cancellingObservation: observations.some((o) => o.outcome === "cancelled" || o.cancel_requested === true),
    committedObservation: fixture.adapter.state.lastCommitted !== null,
    observations,
    events,
    extensionsLoaded: fixture.extensionsLoaded,
  };
}

/** Run both scenarios against the real SDK and return a retained evidence report. */
export async function runQualification({ scratchRoot } = {}) {
  const sdkDist = resolveSdkDist();
  const sdk = await import(pathToFileURL(sdkDist).href);
  const root = scratchRoot || mkdtempSync(join(resolveScratchRoot(), "herdr-compaction-session-"));
  const commitDir = join(root, "commit");
  const cancelDir = join(root, "cancel");
  mkdirSync(commitDir, { recursive: true });
  mkdirSync(cancelDir, { recursive: true });

  const sdkVersion = (() => {
    try {
      return JSON.parse(readFileSync(join(dirname(sdkDist), "..", "package.json"), "utf8")).version;
    } catch {
      return "unknown";
    }
  })();

  const commit = await runCommitScenario({ sdk, scratchDir: commitDir });
  const cancel = await runCancelScenario({ sdk, scratchDir: cancelDir });

  return {
    capability: "bounded-compaction-real-session-boundary",
    live_model_qualification: false,
    runner: "deterministic-in-process-stub",
    sdk: { dist: sdkDist, version: sdkVersion },
    commit,
    cancel,
    scratchRoot: root,
  };
}

/** Assert both scenarios; throw on the first failure. */
export function assertQualification(report) {
  assert.equal(report.live_model_qualification, false, "must be labelled NOT live model qualification");

  // --- commit scenario ---
  assert.equal(report.commit.extensionsLoaded, 1, "extension must be registered through the real loader");
  assert.equal(report.commit.invoked, 1, "runner must be invoked exactly once");
  assert.ok(report.commit.compactionEntry, "a CompactionEntry must be appended");
  assert.equal(report.commit.compactionEntry.fromHook, true, "compaction entry must be recorded as fromHook");
  assert.equal(report.commit.entriesAfter, report.commit.entriesBefore + 1, "session entries must grow by exactly one");
  assert.deepEqual(report.commit.appendedEntries, ["compaction"], "the only appended entry must be the compaction entry");
  assert.equal(report.commit.jsonlCompactionCount, 1, "session JSONL must contain exactly one compaction line");
  assert.equal(report.commit.candidateReady, true, "adapter must report candidate_ready");
  assert.equal(report.commit.committedObservation, true, "adapter must confirm the commit");
  assert.deepEqual(report.commit.committedCodes, ["commit_confirmed"], "commit evidence code must be commit_confirmed");
  assert.equal(report.commit.reconstructed.hasSummary, true, "reconstructed context must contain the summary");
  assert.equal(report.commit.reconstructed.droppedOld, true, "reconstructed context must omit summarized history");

  // --- cancel scenario ---
  assert.equal(report.cancel.extensionsLoaded, 1, "extension must be registered through the real loader");
  assert.equal(report.cancel.appended, false, "cancellation must not append a session entry");
  assert.deepEqual(report.cancel.appendedEntries, [], "cancellation must append no entries");
  assert.equal(report.cancel.entriesAfter, report.cancel.entriesBefore, "entry count must be unchanged");
  assert.equal(report.cancel.jsonlAppended, false, "session JSONL must be unchanged");
  assert.equal(report.cancel.compactionEntries, 0, "no compaction entry may exist after cancellation");
  assert.equal(report.cancel.threw, true, "Pi must surface the cancellation to the caller");
  assert.match(report.cancel.errorMessage ?? "", /cancel/i, "cancellation error should mention cancel");
  assert.equal(report.cancel.committedObservation, false, "adapter must not report a commit on cancellation");
  return report;
}

function parseArgs(argv) {
  return { json: argv.includes("--json"), keep: argv.includes("--keep") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runQualification();
  try {
    assertQualification(report);
  } catch (error) {
    console.error("QUALIFICATION FAILED");
    console.error(error?.stack ?? String(error));
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("compaction real-session boundary: PASS");
    console.log(`  sdk: ${report.sdk.version} (${report.sdk.dist})`);
    console.log(`  commit: entries ${report.commit.entriesBefore} -> ${report.commit.entriesAfter}; jsonl compaction lines ${report.commit.jsonlCompactionCount}`);
    console.log(`  commit: reconstructed hasSummary=${report.commit.reconstructed.hasSummary} droppedOld=${report.commit.reconstructed.droppedOld}`);
    console.log(`  cancel: entries ${report.cancel.entriesBefore} -> ${report.cancel.entriesAfter}; appended=${report.cancel.appended}; threw=${report.cancel.threw}`);
    console.log(`  labels: live_model_qualification=${report.live_model_qualification} runner=${report.runner}`);
    console.log(`  scratch: ${report.scratchRoot}`);
  }
  if (!args.keep) {
    try {
      rmSync(report.scratchRoot, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}

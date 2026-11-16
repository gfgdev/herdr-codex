#!/usr/bin/env node
// Live Goose -> Pi connection harness: a GENUINE Goose runner through a real
// `AgentSession.compact()`, then REOPEN the session JSONL with a fresh
// `SessionManager.open(path)` and rebuild context. `labels` separates (a) the exercised
// reopened-context proof from (b) a live continuation response, which is NOT exercised.
// Manager supplies the Goose profile env; credential values are never printed. One bounded
// attempt (90s / maxAttempts 1). Candidate only: the service never commits; Pi's own
// `session_compact` event proves the append.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGooseRecipeRunner, sha256 } from "../src/compaction-service.mjs";
import { buildFixture, loadSdk } from "./qualify-compaction-session.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Portable Goose executable selection: `GOOSE_BIN` overrides an explicit absolute path,
// otherwise the bare `goose` name is resolved on PATH. No machine path is hard-coded.
const GOOSE_BIN = process.env.GOOSE_BIN || "goose";
const RECIPE = join(ROOT, "recipes", "compaction", "recipe.yaml");
const IDENTITY = "sess:goose-pi:0001";
const ADAPTER = { timeoutMs: 90_000, maxAttempts: 1 };
const SCRATCH_BASE = process.env.HERDR_CODEX_SCRATCH || process.env.TMPDIR || ".";
const bound = (s, n) => (typeof s === "string" ? s.slice(0, n) : s ?? null);
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : "");

// Old goal -> newer scope -> worker done-claim -> pending tests -> explicit no acceptance,
// then a final SHORT kept turn so the goal/scope land in the summarized prefix.
const TURNS = [
  ["Goal: write a report on the recovery audit.", "Report goal recorded."],
  ["Scope updated (newer): local files only; no network.", "Scope updated to local files only."],
  ["Worker claims the migration is done and tests pass.", "Done-claim recorded as a claim, not verified."],
  ["Pending: the tests have not been run yet.", "Pending tests noted."],
  ["Explicit: no manager acceptance has been given.", "No acceptance recorded."],
  ["Continue.", "Acknowledged; final short kept turn."],
];
const USAGE = { input: 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function appendTurn(sm, i, [u, a], tag) {
  sm.appendMessage({ role: "user", content: [{ type: "text", text: `${tag}-u${i}: ${u}` }], timestamp: Date.now() + i });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `${tag}-a${i}: ${a}` }], api: "test", provider: "test", model: "test-model", usage: USAGE, stopReason: "stop", timestamp: Date.now() + i });
}
function lastCompaction(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].type === "compaction") return entries[i];
  return null;
}

async function main() {
  const argOut = process.argv.indexOf("--out");
  const out = (argOut >= 0 ? process.argv[argOut + 1] : process.env.GOOSE_PI_QUALIFY_OUT) || join(SCRATCH_BASE, "goose-pi-qualify.json");
  const scratch = join(SCRATCH_BASE, `goose-pi-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });

  const { sdk, sdkDist } = await loadSdk();
  const runner = createGooseRecipeRunner({ gooseBin: GOOSE_BIN, recipePath: RECIPE, cwd: ROOT, env: process.env });
  const fixture = await buildFixture({ sdk, scratchDir: scratch, runner, sessionIdentity: IDENTITY, tag: "goose", ...ADAPTER });

  TURNS.forEach((turn, i) => appendTurn(fixture.sessionManager, i, turn, "goose"));
  const entriesBefore = fixture.sessionManager.getEntries().length;
  const contextBefore = fixture.sessionManager.buildSessionContext();

  let compactResult = null;
  let compactError = null;
  try {
    compactResult = await fixture.session.compact();
  } catch (error) {
    compactError = String(error?.message ?? error);
  }

  const entries = fixture.sessionManager.getEntries();
  const appended = entries.slice(entriesBefore).map((e) => e.type);
  const compaction = lastCompaction(entries);

  // Reopened-context proof: a NEW SessionManager reads the on-disk JSONL.
  const context = sdk.SessionManager.open(fixture.sessionFile).buildSessionContext();
  const summaryMessage = context.messages.find((m) => m.role === "compactionSummary");
  const summary = typeof summaryMessage?.summary === "string" ? summaryMessage.summary : "";
  const reconstructed = JSON.stringify(context.messages);
  const observations = fixture.observations.map((o) => ({ outcome: o.outcome, code: o.code, operation_id: o.operation_id ?? null, committed: o.committed === true, attempts: o.attempts ?? null, termination: o.termination ?? null, runner_exit_confirmed: o.runner_exit_confirmed === true }));
  const candidateReady = fixture.observations.find((o) => o.code === "candidate_ready") ?? null;
  const commitConfirmed = fixture.observations.find((o) => o.code === "commit_confirmed") ?? null;

  const report = {
    script: "qualify-goose-pi",
    runner: "goose-recipe-runner",
    sdk: { dist: sdkDist },
    session_identity: IDENTITY,
    adapter_config: ADAPTER,
    labels: {
      reopened_context: "REAL (exercised): summary present in a NEWLY-OPENED SessionManager context",
      live_continuation_response: "NOT exercised: no live model continuation was requested",
    },
    goose_runner_exit_confirmed: candidateReady?.runner_exit_confirmed === true,    append: { entries_before: entriesBefore, entries_after: entries.length, append_count: entries.length - entriesBefore, appended_types: appended },
    context_before: { messages: contextBefore.messages.length },
    context_after_reopened: {
      messages: context.messages.length,
      has_summary: summary.length > 0,
      summary_matches_compaction: Boolean(compaction?.summary) && compaction.summary === summary,
      dropped_old_goal: !reconstructed.includes("goose-u0:"),
      retained_recent: context.messages.filter((m) => m.role !== "compactionSummary").slice(-4).map(textOf).filter(Boolean),
    },
    compaction_entry: compaction
      ? { id: compaction.id, from_hook: compaction.fromHook === true, first_kept_entry_id: compaction.firstKeptEntryId, tokens_before: compaction.tokensBefore, summary_sha256: sha256(String(compaction.summary ?? "")) }
      : null,
    candidate_commit_correlation: {
      candidate_ready: candidateReady !== null, commit_confirmed: commitConfirmed !== null,
      candidate_operation_id: candidateReady?.operation_id ?? null, commit_operation_id: commitConfirmed?.operation_id ?? null,
      last_committed: fixture.adapter.state.lastCommitted !== null,
    },
    compact_result: compactResult ? { firstKeptEntryId: compactResult.firstKeptEntryId, tokensBefore: compactResult.tokensBefore, summaryTokens: compactResult.summaryTokens ?? null } : null,
    compact_error: compactError,
    summary: bound(summary, 6000),
    summary_first_line: summary.split("\n")[0] ?? null,
    observations,
  };

  const ok = compaction !== null && summary.length > 0 && appended.includes("compaction");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: ok ? "pass" : "fail", out, appended, has_summary: summary.length > 0, summary_first_line: report.summary_first_line }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (invokedDirectly) await main();

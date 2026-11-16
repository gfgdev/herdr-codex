// Focused fixture tests for the strict Goose native-envelope extractor and its runner wiring.
// No model call: fixtures are captured Goose envelopes under tests/fixtures/compaction/goose/;
// variants are derived in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractGooseCandidate, createGooseRecipeRunner, createCompactionService } from "../src/compaction-service.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SMALL = join(ROOT, "tests", "fixtures", "compaction", "goose", "goose-output-small.json");
const NATIVE = join(ROOT, "tests", "fixtures", "compaction", "goose", "goose-native-output.json");
const RECIPE = join(ROOT, "recipes", "compaction", "recipe.yaml");

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const clone = (p) => structuredClone(read(p));

function successRequest(env) {
  for (const m of env.messages) {
    for (const b of m.content ?? []) {
      if (b?.type === "toolRequest" && b.toolCall?.value?.name === "recipe__final_output") return b;
    }
  }
  return undefined;
}

function successArgs(env) {
  return successRequest(env)?.toolCall.value.arguments;
}

test("captured native success (raw run) extracts the request arguments", () => {
  const r = extractGooseCandidate(readFileSync(SMALL, "utf8"));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(JSON.parse(r.output), successArgs(read(SMALL)));
});

test("captured native success (with leading user text) is accepted", () => {
  const r = extractGooseCandidate(readFileSync(NATIVE, "utf8"));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(JSON.parse(r.output), successArgs(read(NATIVE)));
});

test("parsed earlier request with an explicitly failed execution pair is tolerated, not unwrapped", () => {
  const env = clone(SMALL);
  const candidate = successArgs(clone(SMALL));
  // Realistic failure: the request PARSED (toolCall.status success) but execution failed.
  const failedRequest = { type: "toolRequest", id: "call_earlier", toolCall: { status: "success", value: { name: "recipe__final_output", arguments: { output: JSON.stringify(candidate) } } } };
  const failedResponse = { type: "toolResponse", id: "call_earlier", toolResult: { status: "error", value: "Validation failed" } };
  env.messages.unshift({ role: "assistant", content: [failedRequest, failedResponse] });
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(JSON.parse(r.output), candidate);
  assert.equal(JSON.parse(r.output).output, undefined); // never unwraps the rejected {output}
});

test("rejected tool only is refused (never unwrapped)", () => {
  const env = clone(SMALL);
  env.messages[0].content[0].toolCall.status = "rejected";
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_output_missing");
});

test("absent response is refused", () => {
  const env = clone(SMALL);
  env.messages[1].content[0].id = "call_different";
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_response_missing");
});

test("mismatched/failed response is refused", () => {
  const env = clone(SMALL);
  env.messages[1].content[0].toolResult.status = "error";
  env.messages[1].content[0].toolResult.value.isError = true;
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_response_failed");
});

test("success response without the native value body is refused (not accepted on status alone)", () => {
  const env = clone(SMALL);
  env.messages[1].content[0].toolResult = { status: "success" };
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_response_malformed");
});

test("duplicate responses for the same request are refused, not last-write-wins", () => {
  const env = clone(SMALL);
  env.messages.push({ role: "user", content: [{ type: "toolResponse", id: successRequest(env).id, toolResult: { status: "success", value: { resultType: "complete", isError: false, content: [] } } }] });
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_response_duplicate");
});

test("response preceding its request is refused", () => {
  const env = clone(SMALL);
  const request = env.messages[0].content[0];
  const response = env.messages[1].content[0];
  env.messages[0].content = [response];
  env.messages[1].content = [request];
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_response_out_of_order");
});

test("incomplete envelope status is refused", () => {
  const env = clone(SMALL);
  env.metadata.status = "in_progress";
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_status_not_completed");
});

test("multiple conflicting successes are refused as ambiguous", () => {
  const env = clone(SMALL);
  const args = successArgs(env);
  env.messages.push({ role: "assistant", content: [{ type: "toolRequest", id: "call_second", toolCall: { status: "success", value: { name: "recipe__final_output", arguments: { ...args, goals: ["conflicting"] } } } }] });
  env.messages.push({ role: "user", content: [{ type: "toolResponse", id: "call_second", toolResult: { status: "success", value: { isError: false, resultType: "complete", content: [] } } }] });
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_output_ambiguous");
});

test("final assistant text that disagrees is refused", () => {
  const env = clone(SMALL);
  const textBlock = env.messages.at(-1).content[0];
  const disagreeing = { ...JSON.parse(textBlock.text), goals: ["different goal"] };
  textBlock.text = JSON.stringify(disagreeing);
  const r = extractGooseCandidate(JSON.stringify(env));
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_final_text_disagrees");
});

test("non-JSON stdout is refused", () => {
  const r = extractGooseCandidate("goose: some human chatter {\"status\":\"ok\"} trailing");
  assert.equal(r.ok, false);
  assert.equal(r.code, "goose_output_not_json");
});

test("createGooseRecipeRunner requests json/no-profile/max-turns 4 and uses the strict extractor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goose-fake-"));
  try {
    const fake = join(dir, "fake-goose.js");
    const log = join(dir, "argv.log");
    writeFileSync(fake, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(readFileSync(process.env.FAKE_FIXTURE, "utf8"));\n`);
    chmodSync(fake, 0o755);
    const runner = createGooseRecipeRunner({
      gooseBin: fake,
      recipePath: RECIPE,
      cwd: ROOT,
      env: { ...process.env, FAKE_ARGV_LOG: log, FAKE_FIXTURE: SMALL },
    });
    const out = await runner({ history_json: "{}", requester_note: "fixture" });
    assert.equal(out.status, "ok", out.detail);
    assert.deepEqual(JSON.parse(out.output), successArgs(read(SMALL)));
    const argv = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
    assert.ok(argv.includes("--quiet"), "captured JSON diagnostic retained --quiet");
    assert.ok(argv.includes("--no-profile"));
    assert.deepEqual(argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2), ["--max-turns", "4"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner surfaces extractor refusal as a runner error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goose-fake-"));
  try {
    const fake = join(dir, "fake-goose.js");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write("not json");\n`);
    chmodSync(fake, 0o755);
    const runner = createGooseRecipeRunner({ gooseBin: fake, recipePath: RECIPE, cwd: ROOT, env: process.env });
    const out = await runner({ history_json: "{}", requester_note: "fixture" });
    assert.equal(out.status, "error");
    assert.equal(out.code, "goose_output_not_json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- service-level regression: a RESOLVED structured runner error must be preserved ---
// The live manager run resolved `{status:"error",code,detail,exit_code,...}` and the service
// reported the generic `runner_protocol`/"did not return a string output" (and reported the
// loop variable `attempts:2` after exhaustion). These are fake runners; no model call.

const BASE_RUN = {
  sessionIdentity: "sess:goose-regression:0001",
  generation: 0,
  firstKeptEntryId: "entry_kept_0001",
  tokensBefore: 128,
  history: [{ role: "user", text: "bounded fixture history" }],
  reason: "manual",
};

test("service preserves a resolved structured runner error and reports one actual call (maxAttempts 1)", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { status: "error", code: "goose_final_response_malformed", detail: "envelope status not completed", exit_code: 0, exit_signal: null, termination: "confirmed" };
  };
  const service = createCompactionService({ runner, maxAttempts: 1 });
  const r = await service.run(BASE_RUN);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "goose_final_response_malformed");
  assert.equal(r.detail, "envelope status not completed");
  assert.equal(r.attempts, 1, "attempts must be actual runner calls, not the loop variable after exhaustion");
  assert.equal(r.spots.length, 1);
  assert.equal(r.spots[0].exit_code, 0);
  assert.equal(r.runner_exit_confirmed, true);
  assert.equal(r.runner_error.code, "goose_final_response_malformed");
  assert.equal(r.runner_exit_code, 0);
  assert.equal(r.applicable, false);
  assert.equal(r.committed, undefined);
  assert.equal(calls, 1, "runner must be invoked exactly once");
  assert.equal(service.stats().runnerCalls, 1);
});

test("service reports one call per attempt for a retryable failure (maxAttempts 2)", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    throw new Error("boom");
  };
  const service = createCompactionService({ runner, maxAttempts: 2 });
  const r = await service.run(BASE_RUN);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "runner_error");
  assert.equal(r.attempts, 2);
  assert.equal(r.spots.length, 2);
  assert.equal(calls, 2);
});

test("resolved structured error still honors retryability: nonretryable code runs once (maxAttempts 2)", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { status: "error", code: "goose_final_output_ambiguous", detail: "2 complete pairs", exit_code: 0, exit_signal: null, termination: "confirmed" };
  };
  const service = createCompactionService({ runner, maxAttempts: 2 });
  const r = await service.run(BASE_RUN);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "goose_final_output_ambiguous");
  assert.equal(r.attempts, 1, "nonretryable code must not be retried");
  assert.equal(r.spots.length, 1);
  assert.equal(calls, 1);
});

test("resolved structured error with a retryable code retries up to maxAttempts (2)", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { status: "error", code: "runner_protocol", detail: "parseOutput returned an unusable result", exit_code: 0, exit_signal: null, termination: "confirmed" };
  };
  const service = createCompactionService({ runner, maxAttempts: 2 });
  const r = await service.run(BASE_RUN);
  assert.equal(r.outcome, "failed");
  assert.equal(r.reason, "runner_protocol");
  assert.equal(r.attempts, 2, "retryable code must get the fallback attempt");
  assert.equal(r.spots.length, 2);
  assert.equal(calls, 2);
});

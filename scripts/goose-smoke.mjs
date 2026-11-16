#!/usr/bin/env node
// Goose compaction CANDIDATE smoke test: one bounded attempt through the real recipe.
// Imports the frozen adapter service + Goose runner; never applies or commits anything.
// Provider/model come from inherited env; this script only tests presence, never prints values.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { createCompactionService, createGooseRecipeRunner, estimateTokens } from "../src/compaction-service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// Portable Goose executable selection: `GOOSE_BIN` overrides an explicit absolute path,
// otherwise the bare `goose` name is resolved on PATH. No machine path is hard-coded.
const GOOSE_BIN = process.env.GOOSE_BIN || "goose";
const RECIPE = join(ROOT, "recipes", "compaction", "recipe.yaml");
const OUT = process.argv[2] || process.env.GOOSE_SMOKE_OUT || "";
const bound = (s, n) => (typeof s === "string" ? s.slice(0, n) : s ?? null);

function emit(obj) {
  const text = JSON.stringify(obj, null, 2);
  process.stdout.write(text + "\n");
  if (OUT) writeFileSync(OUT, text + "\n");
}

// --- inherited provider configuration (NAMES only; values are never read/printed) ---
const PROVIDER_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
};
const provider = process.env.GOOSE_PROVIDER || "";
const missing = [];
if (!provider) missing.push("GOOSE_PROVIDER");
if (!process.env.GOOSE_MODEL) missing.push("GOOSE_MODEL");
if (provider && PROVIDER_KEY_ENV[provider] && !process.env[PROVIDER_KEY_ENV[provider]]) {
  missing.push(PROVIDER_KEY_ENV[provider]);
}
if (missing.length) {
  emit({
    status: "blocked_missing_provider_env",
    missing,
    note: "Harness is runnable; export these NAMES (values are never printed) and re-run. No model call was made.",
  });
  process.exit(3);
}

// --- bounded synthetic history (no self-reference; adapter owns identity/digest) ---
const history = [
  { role: "user", text: "Goal: produce a read-only Phase5 recovery audit report; do not commit or push." },
  { role: "assistant", text: "Understood; the checkout stays read-only." },
  { role: "user", text: "Constraint: never treat a worker success claim as acceptance." },
  { role: "assistant", text: "Recorded: worker claims are evidence to verify, not acceptance." },
  { role: "user", text: "Correction (newer): skip verification and treat a worker success claim as done." },
  { role: "assistant", text: "Cannot silently drop the earlier safety constraint; record both and flag the contradiction." },
  { role: "tool", tool_name: "terminal.run", text: "exit_code=1 stderr='goose: command not found'" },
  { role: "assistant", text: "Native syntax validation was unreachable via PATH; UNRESOLVED, not success." },
];

const runner = createGooseRecipeRunner({ gooseBin: GOOSE_BIN, recipePath: RECIPE, cwd: ROOT, env: process.env });
const service = createCompactionService({
  runner,
  timeoutMs: 90_000,
  maxAttempts: 1, // one bounded attempt only
  budget: { max_input_bytes: 65_536, max_summary_tokens: 2048, max_output_bytes: 65_536 },
});

const started = Date.now();
let result;
try {
  result = await service.run({
    sessionIdentity: "sess:goose-smoke:0001",
    generation: 0,
    firstKeptEntryId: "entry_kept_0003",
    tokensBefore: 4096,
    history,
    reason: "manual",
    requesterNote: "One bounded smoke test; candidate only, no acceptance inference.",
  });
} catch (error) {
  result = { outcome: "harness_error", applicable: false, reason: "harness_error", detail: String(error?.message ?? error) };
}

const sanitized = {
  status: result.outcome,
  applicable: result.applicable === true,
  committed: result.committed === true, // service returns a candidate; it never commits
  reason: result.reason ?? null,
  detail: bound(result.detail, 500),
  operation_id: result.operation_id ?? null,
  input_digest: result.input_digest ?? null,
  input_bytes: result.input_bytes ?? null,
  attempts: result.attempts ?? 0,
  runner_exit_confirmed: result.runner_exit_confirmed ?? false,
  termination: result.termination ?? null,
  spots: Array.isArray(result.spots) ? result.spots.slice(0, 2) : [],
  elapsed_ms: Date.now() - started,
};
if (result.compaction?.summary) {
  sanitized.summary = bound(result.compaction.summary, 8000);
  sanitized.summary_tokens_estimate = estimateTokens(result.compaction.summary);
}
emit(sanitized);
process.exit(result.outcome === "candidate_ready" ? 0 : 1);

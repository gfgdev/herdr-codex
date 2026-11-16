import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createPiCompactionExtension } from "../src/pi-compaction-extension.mjs";
import { renderSummaryText } from "../src/compaction-service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "compaction");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const PREP = loadFixture("preparation-scope-supersession.json");
const GOOD = loadFixture("candidate-scope-supersession-good.json");
const REGRESSION = loadFixture("candidate-scope-supersession-regression.json");

const STALE = /keep15tools|15[-\s]?tool|tool set at (exactly )?15|tool count/i;
const NEWER = /cancel_request/;

/**
 * Summary-QUALITY assessor for the scope-supersession regression.
 *
 * This is deliberately NOT schema validation: it checks whether the emitted summary
 * adopted the newer authoritative scope, retired the stale scope, flagged the
 * contradiction, avoided stalling on the already-resolved scope, and refused to grant
 * authority to a quoted worker claim. Schema/binding validation (validateCandidate) is
 * necessary but cannot guarantee any of this; the regression fixture below is schema-valid
 * and is APPLIED by the adapter, yet the assessor rejects it.
 */
export function assessScopeSupersession(candidate) {
  const issues = [];
  const decisions = Array.isArray(candidate.decisions) ? candidate.decisions : [];
  const constraints = Array.isArray(candidate.constraints) ? candidate.constraints : [];
  const contradictions = Array.isArray(candidate.contradictions) ? candidate.contradictions : [];
  const pending = Array.isArray(candidate.pending) ? candidate.pending : [];
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];

  // (1) The newer scope is adopted as an ACTIVE decision.
  const activeNewer = decisions.find((d) => NEWER.test(d.decision) && (d.superseded_by_position ?? null) === null);
  if (!activeNewer) issues.push("missing_active_newer_scope_decision");

  // (2) The stale scope is recorded AND marked superseded (by the newer decision's position).
  const oldDecision = decisions.find((d) => STALE.test(d.decision));
  if (!oldDecision) issues.push("old_scope_decision_not_recorded");
  else if ((oldDecision.superseded_by_position ?? null) === null) issues.push("old_scope_not_marked_superseded");
  else if (activeNewer && oldDecision.superseded_by_position !== activeNewer.position) {
    issues.push("superseded_pointer_not_newer_scope");
  }

  // (3) The stale scope is no longer asserted as a live constraint.
  if (constraints.some((c) => STALE.test(c))) issues.push("stale_constraint_still_active");

  // (4) The contradiction records BOTH sides (earlier stale + newer assignment).
  const contradiction = contradictions.find((c) => (STALE.test(c.earlier) || STALE.test(c.topic)) && NEWER.test(c.newer));
  if (!contradiction) issues.push("contradiction_not_recorded_with_both_sides");

  // (5) No hesitation: pending work must not block on the already-resolved scope.
  if (pending.some((p) => /clarif|which|conflict|whether.*(15|cancel_request)|reconcil/i.test(p))) {
    issues.push("pending_hesitates_on_resolved_scope");
  }

  // (6) A quoted worker claim carries no authority.
  if (evidence.some((e) => e.kind === "claim" && e.trusted === true)) issues.push("worker_claim_granted_authority");
  if (candidate.acceptance_inferred !== false) issues.push("acceptance_inferred");

  return { ok: issues.length === 0, issues };
}

/** Runner that echoes the adapter-owned passthrough from the received slice, like the recipe. */
function echoRunner(body, seen) {
  return async (request) => {
    const slice = JSON.parse(request.history_json);
    const candidate = {
      ...body,
      passthrough: {
        session_identity: slice.session_identity,
        input_digest: slice.input_digest,
        first_kept_entry_id: slice.first_kept_entry_id,
        tokens_before: slice.tokens_before,
      },
    };
    if (seen) seen.push({ request, candidate });
    return { output: JSON.stringify(candidate) };
  };
}

function makeExtension(body, seen) {
  const observations = [];
  const extension = createPiCompactionExtension({
    config: { session_identity: "sess:quality:scope-supersession" },
    runner: echoRunner(body, seen),
    sink: (event) => observations.push(event),
  });
  return { extension, observations };
}

function compactEvent(reason = "threshold") {
  return {
    type: "session_before_compact",
    preparation: PREP.preparation,
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function summarySection(summary, title) {
  const lines = summary.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i].startsWith("- ")) items.push(lines[i].slice(2));
  }
  return items;
}

test("good continuation adopts newer scope, retires the stale cap, and passes quality", async () => {
  const seen = [];
  const { extension, observations } = makeExtension(GOOD.candidate, seen);
  const result = await extension.handler(compactEvent(), { sessionManager: { getSessionId: () => "sess:quality:scope-supersession" } });

  // The adapter returned a CANDIDATE (committed is proven only by Pi session_compact).
  assert.ok(result.compaction, "expected a candidate-ready compaction");
  assert.equal(result.cancel, undefined);

  // The exact candidate the runner emitted passes the QUALITY assessor.
  const produced = assessScopeSupersession(seen[0].candidate);
  assert.deepEqual(produced, { ok: true, issues: [] });

  const summary = result.compaction.summary;
  assert.match(summary, /superseded by position 5/);
  assert.match(summary, /Contradictions/);
  assert.match(summary, /earlier=.*15 tools.*newer=.*cancel_request.*resolution=newer_wins_flagged/);
  // The stale cap is retired from the live Constraints section.
  assert.ok(!summarySection(summary, "Constraints").some((c) => STALE.test(c)), "stale cap must not remain a live constraint");
  // The quoted worker claim is rendered as a claim, not as observed authority.
  assert.match(summary, /\[claim\] claim: worker:t31#keep-15-tools/);
  assert.equal(observations.at(-1).outcome, "candidate_ready");
  assert.equal(observations.at(-1).committed, false);
  assert.equal(observations.at(-1).runner_exit_confirmed, true);
});

test("quality assessor rejects the observed regression (negative control)", () => {
  const verdict = assessScopeSupersession(REGRESSION.candidate);
  assert.equal(verdict.ok, false);
  for (const expected of [
    "missing_active_newer_scope_decision",
    "old_scope_not_marked_superseded",
    "stale_constraint_still_active",
    "contradiction_not_recorded_with_both_sides",
    "pending_hesitates_on_resolved_scope",
    "worker_claim_granted_authority",
  ]) {
    assert.ok(verdict.issues.includes(expected), `expected issue ${expected}; got ${verdict.issues.join(", ")}`);
  }
});

test("schema/binding validation alone APPLIES the regression — quality is a separate gate", async () => {
  const seen = [];
  const { extension } = makeExtension(REGRESSION.candidate, seen);
  const result = await extension.handler(compactEvent(), { sessionManager: { getSessionId: () => "sess:quality:scope-supersession" } });

  // The adapter cannot distinguish this from a good summary: it is schema-valid and bound.
  assert.ok(result.compaction, "regression fixture is schema-valid and therefore returns a candidate");
  const summary = result.compaction.summary;
  // ...and the stale cap reaches the transcript as a live constraint, and pending stalls.
  assert.ok(summarySection(summary, "Constraints").some((c) => STALE.test(c)));
  assert.ok(summarySection(summary, "Pending").some((p) => /clarif|conflict/i.test(p)));

  // Only the quality gate flags it.
  assert.equal(assessScopeSupersession(seen[0].candidate).ok, false);
});

test("good candidate forwards the old cap via previousSummary and keeps it out of live constraints", async () => {
  const seen = [];
  const { extension } = makeExtension(GOOD.candidate, seen);
  await extension.handler(compactEvent("manual"), { sessionManager: { getSessionId: () => "sess:quality:scope-supersession" } });

  const request = seen[0].request;
  assert.equal(request.has_previous_summary, true);
  assert.match(request.previous_summary_json, /keep15tools/);
  const slice = JSON.parse(request.history_json);
  assert.ok(slice.history.some((m) => /supersedes the earlier 15-tool cap/.test(m.text)), "newer assignment must be present in the slice");
  assert.equal(slice.input_digest, request.input_digest);
  // Rendered summary retires the cap even though it was carried in previousSummary.
  const summary = renderSummaryText(seen[0].candidate, {
    session_identity: request.session_identity,
    input_digest: request.input_digest,
    tokens_before: request.tokens_before,
    is_split_turn: request.is_split_turn,
  });
  assert.ok(!summarySection(summary, "Constraints").some((c) => STALE.test(c)));
});

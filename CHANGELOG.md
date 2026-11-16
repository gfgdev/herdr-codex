# 0.11.0-beta.1 — recipient-ready prerelease package and documentation

This is a **prerelease**. It adds no activation: no automation is enabled by default and
the compaction adapter stays dormant and opt-in. It packages the accepted desk-overview
read/observe surface with a clear recipient setup path and corrects stale documentation.

- **Version identity.** `package.json` and `plugin/plugin.json` now both read
  `0.11.0-beta.1`; the builder still requires the two manifests to agree and refuses to
  build over an existing destination or archive.
- **Recipient quickstart.** New `docs/QUICKSTART.md` covers supported prerequisites
  (macOS, Node 22.19+ incl. `node:sqlite`, Python 3, native Herdr core/desktop, Pi and
  optional Goose, Codex app-server protocol `0.167.0-alpha.4.1`), the local-marketplace
  install, configuration with **your own absolute paths, approved credential file and
  existing Codex chat UUIDs**, the read-only `plugin doctor` check, real wake
  qualification, and the disabled-by-default summary.
- **Recipe catalog.** New `docs/recipe-catalog.md` documents the three optional Desk
  recipe starters (`coding-change`, `research-brief`, `operations-batch`) with their
  disabled automations, plus the dormant opt-in compaction example and its narrow
  synthetic manual qualification status.
- **Troubleshooting, upgrade/rollback and limitations.** New `docs/troubleshooting.md`
  covers the common failures (no tools surfaced, queue receipt without wake, native
  startup, sandbox/socket access, desk validation, triggers, ambiguous duplicate work),
  upgrade and rollback via the disposable plugin cache and content-keyed runtime snapshot,
  and the package's explicit limits.
- **Compaction wording corrected.** `recipes/compaction/integration-contract.md` no longer
  claims "no live inference has been run": it now cites the recorded narrow synthetic
  manual Goose → Pi slice in `docs/compaction-live-qualification.md` while keeping
  automatic/near-limit recovery explicitly unqualified and the hooks unwired.
- **One shared Desk space.** `examples/desks/README.md` and `docs/general-desks.md` now
  describe desk agents and files as occupying the desk's **one shared Desk space**
  (`docs/desks.md`), rather than separate spaces per view, consistent with the starter
  README and example text.
- **Packaging.** `scripts/build-plugin.mjs` ships `docs/QUICKSTART.md`,
  `docs/recipe-catalog.md` and `docs/troubleshooting.md` with the plugin and writes a
  recipient-facing artifact `README.md` that points at them. Packaging remains source-only
  with zero model calls.
- **MIT license and public-source policy.** Added `LICENSE` (MIT, "2026 Herdr–Codex
  contributors"), `CONTRIBUTING.md` and `SECURITY.md`; `license: MIT` now appears in
  `package.json`, `plugin/plugin.json` and the generated runtime manifest. The builder
  ships the three documents with the plugin, and the bundled `js-yaml` MIT notice is still
  carried in `docs/THIRD-PARTY.md`. Repository links target `gfgdev/herdr-codex` and are
  marked **planned** pending verification.
- **Portable qualification harnesses.** `scripts/qualify-compaction-session.mjs`,
  `scripts/qualify-goose-pi.mjs` and `scripts/goose-smoke.mjs` no longer hard-code machine
  paths: they honor `PI_CODING_AGENT_DIST` / `GOOSE_BIN` (or resolve the installed package,
  or fall back to `goose` on `PATH`) and fail with explicit guidance otherwise. They still
  never print credentials and never change the selected provider/model.
- **Scrubbed synthetic fixtures.** `recipes/compaction/fixtures/input-slice.json` and
  `tests/fixtures/compaction/preparation-simple.json` now use the generic placeholder path
  `/synthetic/example/project` instead of a personal absolute path; the adapter tests are
  unchanged and still pass.
- **Public source export manifest.** New `docs/public-source-export.md` and `.gitignore`
  record exactly which paths are published and which stay local (`inputs/`,
  `docs/local-herdr-direct-SKILL.md`, six private historical reports). No local evidence is
  deleted, and no historical evidence is rewritten. The document separates runnable
  post-clone checks from development-checkout evidence.
- **Public-clone test correctness and link hygiene (revision).** `tests/release-docs.test.mjs`
  no longer requires the excluded private documents to be present, so `npm test` passes in a
  public clone; the test now asserts the decidable contract instead (excluded paths are
  never linked from exported documents, and the source-layout documentation links resolve).
  `docs/recipe-catalog.md` links the dormant compaction assets at their **source** path
  (`recipes/compaction/`), and `scripts/build-plugin.mjs` rewrites those links to
  `examples/compaction/` while packaging, so the installed plugin links resolve too; the
  catalog and the export guide document both layouts. Retained historical reports
  (`docs/reports/0.8.0.md`, `docs/reports/0.8.2.md`) reference the excluded `0.8.1` note as
  plain text rather than a relative link, so the published tree has no dangling references.
- **Accurate third-party notice (revision).** `docs/THIRD-PARTY.md` no longer claims the
  bundled js-yaml copy is unmodified. It now describes `src/vendor-js-yaml.mjs` as a
  **bundled ESM-compatible adaptation** (CommonJS-interop helper plus lazy `require*()`
  initializers, with a dangling `sourceMappingURL` comment for a map that is not shipped),
  records the js-yaml 4.3.2 version as **recorded provenance that is not independently
  verified**, and identifies the copy by its own SHA-256. The upstream MIT notice is
  retained verbatim, and the vendored runtime file is unchanged (no re-fetch or rebuild).
- **Verified public destination (revision).** The source repository
  [github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex) is created and
  verified public, so `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and
  `docs/public-source-export.md` now link it directly (with the
  [issue tracker](https://github.com/gfgdev/herdr-codex/issues)) instead of describing it
  as planned or unverified. `README.md` gains a **Download and install** section pointing
  at [github.com/gfgdev/herdr-codex/releases](https://github.com/gfgdev/herdr-codex/releases)
  with instructions to download the packaged release asset, verify its SHA-256 and
  install the extracted local marketplace.

# 0.10.1 — reconnection, Goose envelope strictness and compaction qualification

- **Next-explicit-request RPC reconnection.** `src/rpc-connection.mjs` lazily opens one
  native `hc connect` connection and, once it has closed, opens exactly one replacement on
  the **next explicit request**. It deliberately never replays the request that observed the
  closure: an in-flight mutation may already have reached Herdr, so the caller keeps the
  original uncertainty instead of silently re-sending after a possibly-lost receipt.
  Concurrent calls after a closure share the one replacement, and a stale close from an
  already-replaced connection cannot discard the newer one.
- **Strict native Goose JSON envelope.** The compaction adapter's Goose extractor accepts
  only the captured native JSON envelope and requires a **paired successful tool-result**:
  the final-output request must be parsed *and* its matching response present, in order,
  successful and well-formed. Earlier explicitly failed result pairs may precede the unique
  later successful pair; those failures are tolerated and their outputs are never accepted.
  Rejected, absent, duplicated, out-of-order or conflicting pairs are refused by name rather
  than unwrapped. Resolved runner errors
  keep their structured `code`/`detail`/exit evidence, and the service reports **actual
  runner calls** (`attempts`, honoring retryability per code) instead of the exhausted loop
  counter.
- **Manual Goose→Pi compaction qualification (evidence only).**
  `docs/compaction-live-qualification.md` records a manager-observed manual Goose→Pi append
  and persisted reopen (`inputs/qualification/pi-append-reopen.json`) plus a separately
  observed fresh no-tools Pi continuation (`inputs/qualification/pi-live-continuation.json`).
  These raw captures live in the **development checkout only** and are excluded from the
  public source export; they are cited as recorded evidence, not as runnable checks.
  It qualifies a **synthetic manual case only**: production extension hooks remain dormant,
  with no automatic/near-limit guarantee and no usage-savings percentage. The packaged
  plugin now also ships that qualification document; no private runtime or evidence is copied
  into the artifact.
- The manager's local runtime launcher required a **physical-path repair** in its
  environment; this was environment recovery, not a portable code feature.
- The main source checkout and prior workers remain preserved; this isolated checkout is the
  release source.

# 0.10.0 — scoped inbox, durable review/cancellation and a compaction example

- **Scoped notification inbox.** `receive_notification` now reconciles exactly the
  member reports of the current notification envelope instead of sweeping the whole
  chat inbox. Unrelated receipts and future wakes are preserved, and an already
  received envelope replays without duplicating effects.
- **Durable review packets and revision-bound reviews.** `src/review-packets.mjs`
  captures a compact, replayable evidence packet for one notification-handling
  operation, and `src/revision-reviews.mjs` binds review/acceptance to the exact
  content revision, worker, task, chat, launch and activation. The
  `capture_review`, read-only `verify_review` and revision-bound `resolve_message`
  tools expose this over the existing MCP surface; they remain evidence-only and
  never signal a worker.
- **Owner-scoped request cancellation.** `agent cancel-request` / `cancel_request`
  retires an unclaimed outbound operation. The caller must pass the exact owner
  manager chat UUID, which is compared against the registered task thread before the
  request row is read, and an atomic `--expected-state` precondition guards the
  transition; a different chat is refused as `Not your request`.
- **Bounded-compaction example (dormant).** A reviewed bounded compaction recipe,
  JSON schema, parameter encoder and integration contract ship under
  `examples/compaction` as documentation only. Nothing is auto-wired: the adapter
  modules require a caller-supplied absolute recipe path, so live qualification and
  explicit durable asset selection are still required. The plugin builder packages
  exactly those four assets (no fixture tree) and verifies the packaged modules
  import.
- The plugin builder's YAML allowance is narrowed to an explicit list of reviewed
  example files instead of a directory-wide rule.

# 0.9.0 — truthful steering, interruption and intentional stop

- Separate the three meanings a delivery receipt can carry. Every request now
  records a `delivery` value: `queued` (durable only), `native-injected` (the
  native transport accepted the input; consumption is **not** confirmed),
  `confirmed` (observed evidence recorded by an operator), `refused` (terminal
  non-delivery) or `uncertain`. A `sent` receipt is never reported as the model
  having consumed or completed the work; the record carries an actionable next
  state instead.
- `agent reconcile` upgrades a `native-injected` record to `confirmed` from
  actual terminal evidence and journals `agent.request.confirmed`; it never
  performs a second native send.
- Interruption is confirmed against the **original** native identity (address,
  pid, argv, task/desk labels and any adopted immutable identity). `agent
  interrupt` reports `confirmed` only when that validated original terminal is
  observed idle, done or finished; a vanished terminal is **not** proof the turn
  stopped, so the request stays `uncertain` and blocks later input until it is
  reconciled. Session and writer lease are retained; no subprocess termination is
  claimed from an idle/turn-end observation alone.
- New intentional stop (`agent stop` / `stop_agent` MCP tool): records intent
  **before** the native kill together with an explicit durable dispatch state
  (`not-dispatched` → `dispatching` → `accepted`/`refused`/`uncertain`). A
  recorded intent alone is never a deliberate stop: only an acknowledged kill
  (`accepted`) plus an observed original `finished` exit is reported as
  intentional; an original already finished before dispatch is `already-exited`;
  a refused, in-flight or ambiguous dispatch with an observed exit is
  `unattributed`. The confirmed transition — stopped state, writer-lease release,
  request receipt, the single `agent.stopped` audit row and one lifecycle notice
  — commits atomically, preserves terminal history and refuses later input.
  Retrying the same `--request-id` re-checks confirmation without killing again,
  and a late native receipt/refusal is retained without rewriting the settled
  verdict. A replaced process (explicit identity mismatch, validated for both
  live and finished states) is never excused by stop intent and still faults.
- Serialize per-agent delivery with two barriers: an order-independent in-flight
  barrier (any other `sending`/`uncertain` operation, including an inline message
  with a lost receipt) plus order-dependent earlier-`prepared` predecessor
  ordering. `stop` bypasses every barrier; `interrupt` bypasses unresolved normal
  input but never another unresolved interrupt. Retries and restarts reuse the
  durable request record and never duplicate a send.
- The default bridge wake set now includes the confirmed stop lifecycle event
  (`agent.stopped`) alongside request outcomes, so a manager can end its turn and
  be woken by the exact existing chat on a result, question, blocked state or
  intentional stop without polling. The manager's own administrative
  `agent.stop.requested` is deliberately excluded so issuing a stop never wakes
  the very wait that asked for it.
- Documentation records the native-capability boundary honestly: truthful
  receipts and confirmed interruption depend on the native lifecycle APIs the
  local installation exposes; where consumption cannot be verified, the boundary
  is stated rather than guaranteed.

# 0.8.2 — durable runtime retention

- Publish an immutable, source-only runtime snapshot under the integration state
  directory (`<stateDir>/runtime/v1-<content-key>`) before any command runs, and
  pin `config.packageRoot` to it. Workers, helpers, Goose hooks/recipes, the
  notification inbox and the bridge therefore keep running when the installed
  plugin cache is pruned or replaced (for example by a Codex plugin upgrade).
- The snapshot contains exactly the shipped `src/*.mjs`/`src/*.py` sources plus a
  manifest. It never copies credentials, model/binaries, user state or unrelated
  files. Publication is atomic (staged directory + `rename`) and immutable
  (`0o400` files, `0o500` directories), keyed by content so identical runtimes
  reuse one copy and changed sources publish a new one.
- Reuse revalidates the recorded manifest and every file digest; a tampered,
  extended, corrupt or symlink-substituted snapshot is refused rather than
  trusted. Concurrent publication converges on one validated snapshot, and a
  losing publisher cleans only its own staging directory.
- The bridge continues to register and execute from the pinned snapshot
  (`config.packageRoot/src/cli.mjs`); its lock, ownership and lifecycle are
  unchanged, so no duplicate or restart is triggered.
- Legacy sessions launched before 0.8.2 keep their existing paths until they
  drain; they are not retroactively migrated (see `docs/reports/0.8.2.md`).

# 0.8.1 — local MCP discovery and visible panels

- Fix the plugin-local MCP manifest: `plugin/mcp.json` now uses the plugin-relative
  `./scripts/herdr-agents.sh` command, so the host surfaces `herdr-agents` tools
  instead of an empty catalog. Absolute/out-of-tree commands are rejected by the
  Agent Plugins schema.
- Add read-only `plugin doctor` (`node src/cli.mjs plugin doctor`): validates the
  local manifests and performs one MCP initialize/tools-list handshake. It
  requires an **enabled** `herdr-agents` entry from `codex mcp list` and prints
  remediation as a quoted `/bin/sh` command. No tool call, worker launch, model
  request or write.
- Add `show_agent` and the optional `spawn_agent` `show` flag: verified visible
  panel placement through the existing `showWorker` path, with optional
  `space_id`/`place` and explicit matching space identity. A zero-match `show`
  creates exactly the canonical project space or returns a `create-space-required`
  action; it never uses the currently selected space and `show_agent` keeps the
  placement `verified` value.
- Preserve the full 48-char `task_name` (and `read_agent`/`list_agents` output)
  after the 32-char native truncation, and refuse ambiguous truncated aliases
  instead of guessing. `read_agent` returns a whitelisted `native` summary only
  and re-bounds `screen.text` to the requested `lines` tail, reporting
  `screen.truncated` and `screen.total_lines` when the native scrollback exceeded
  it.
- Placement failures are reported separately as
  `{status:'unavailable',verified:false,warning}` and never fail, close, restart or
  duplicate an agent that already launched.
- Normalize tool payloads to canonical `snake_case` identifiers (`agent_id`,
  `task_name`, `request_id`, `launch_state`, `terminal_id`, `space_id`) and drop
  duplicate camelCase mirrors; retry-recovery identities and delivery states are
  retained.
- `send_message`, `followup_task` and `interrupt_agent` return a short receipt:
  identity, durable `state`, `request_id`/`fingerprint`, native receipt and any
  `error`/`note`, but never the assignment `payload` or exact `wire_text`. The
  full assignment is still delivered and stored; identical retries return the
  same receipt and uncertainty keeps its identity.
- Tool contract is now ten tools; build and tests assert the new count.

# 0.6.0 — native access and evolution

- Transparent native arguments, streams, signals and PTY interaction; fix native --config collisions and wrapper stderr warnings.
- Versioned installed help/schema/command catalogs, dynamic search/description, stale revision handling and candidate contract reports.
- Explicit existing-worker and verified-child adoption, identity pinning, task/Desk/chat routing, native lifecycle attention and child-specific reporting bindings.
- Isolated behavioral qualification with exact binary/source/summary fingerprints, cleanup evidence, no runtime activation or model requests.
- Existing game and OPA work remains outside qualification and adoption.

# Changes

## 0.4.1 — writable desk knowledge

- Default newly linked Obsidian vaults to read/write, including later vault attachment.
- Add explicit, journaled resource access changes without repointing resource identities or expanding existing worker grants.
- Reject access changes while active agents or unsettled jobs reference the resource, and retain read-only specialist behavior.

## 0.4.0 — persistent desks

- Add desk homes, referenced vaults/resources and explicitly registered projects.
- Add work registers, versioned specialists/manual workflows, frozen jobs and scoped activity.
- Bind desk delegates to exact projects, definitions and manager chats; claim primary ownership before native launch.
- Preserve frozen context and grants across retries and future definition changes; require evidence and resolved messages before settlement.
- Display verified workers from explicitly registered desk projects in matching native desk spaces, retaining legacy placement protections.
- Keep external resources as disconnected metadata; QMD, scheduling and authenticated mail/spreadsheet operations remain deferred.

## 0.3.2 — coalesced notification delivery

- Maintain one mutable queued notification per chat, withdraw handled entries, and preserve unrelated host messages.
- Reconcile uncertain delivery without blind retries and preserve delivery-error visibility through native heartbeats.
- Strengthen native project/task identity and desktop placement checks.

## 0.3.0 — persistent delegation

- Scope desktop `show` to the worker checkout; reject unrelated selected spaces and verify split anchors.

- Add one-command `delegate`, same-session follow-ups, active/queued messages, roster, terminal text reads, bounded event waits, interruption and delivery reconciliation.
- Freeze selected context and template instructions; add explorer, implementer, reviewer, tester and investigator templates plus private reusable custom templates.
- Persist request claims and queued-note ownership. Duplicate IDs cannot relaunch/resend, uncertain receipts require evidence, and continuation cannot overtake initial delivery or revive a closed task.
- Enforce one writer per checkout atomically, including disjoint writable paths.
- Add acknowledged local activity subscriptions to the existing bridge, without filesystem polling, scheduled Codex checks or another manager.
- Preserve full native CLI/app access, selected model and existing message/ack APIs. Exact Codex history forks and built-in-tool interception remain unavailable.


## 0.2.1 — November 12, 2026

- A quarantined crashed peer no longer silences healthy teammates' automatic
  completion notices. Its separate fault and writer reservation remain protected.

## 0.2.0 — November 12, 2026

- Add automatic attention when observed work ends and the team settles without
  an explicit manager report; aggregate peer handoffs and suppress covered or
  repeated notices. Startup idle is not a completed task.
- Report blocked/error states and runtime loss, exit, replacement or removal with
  bounded native terminal text. Preserve faults after results and guard against
  sending normal instructions to a replacement shell.
- Persist work observations for replay, reconnect and listener-restart recovery.
  Settled means inspect the work, never automatic acceptance. Silent hangs without
  an event/message are outside this event-driven mechanism.
- Make plugin configuration independent of cwd: explicit argument, environment,
  then `~/.config/herdr-codex/config.json`. Add a private reference installer that
  does not overwrite another installation or copy credentials/state.
- Default operating guidance to native screen text, prose sends, named keys and
  app CLI controls. Goose is optional. No routine screenshots/vision, periodic
  Codex checks, fixed workflow engine or arbitrary request cutoffs are added.
- Pass six isolated native event scenarios (62 events, seven captured dispatches,
  no models or actual host dispatch) and eight focused configuration checks.
  The actual idle heartbeat caused zero terminal reads or wake attempts.

## 0.1.2 — November 12, 2026

- Explicitly include Python 3 in portable prerequisites and setup validation.
  Runtime code is unchanged from 0.1.1.

## 0.1.1 — November 12, 2026

- Give native workers their exact writable scratch path and a shell-quoted,
  absolute `mktemp` template. Set TMPDIR, TMP, TEMP and HERDR_CODEX_SCRATCH.
- Tell reviewers to verify fixture setup and expected child status/output,
  preserve failed/blocked checks, and support timing/causality claims with actual
  process evidence. A successful wrapper command is not proof of every probe.
- Add real temporary-file and read-only macOS sandbox regression coverage.
- Qualify actual post-turn question and result wakes on the current Codex host,
  direct Pi–Goose review and correction, and independent project acceptance.

Existing worker conversations are retained. The launcher instructions apply to
new launches; the live review received the equivalent correction through its
existing native conversation. No OPA installation changes are included.

## 0.1.0 — November 12, 2026

- Native Herdr CLI and desktop access, task/worker registration and isolated state.
- Durable CAS mailboxes, an event-driven bridge and existing-chat Codex delivery.
- Recorded replies/decisions before acknowledgment, recovery and duplicate handling.
- Native Pi and Goose roles using the selected model, with direct peer consultation.
- Mac-first skills-only plugin, configuration guide and portable marketplace builder.

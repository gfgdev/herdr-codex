# Adopting existing Herdr workers

Codex can operate native `hc` and `herdr-app` directly. A worker started directly through Herdr needs an explicit binding before it has integration-owned Desk/task/chat routing.

```sh
herdr-codex native get t7
herdr-codex native read t7 --lines 100
herdr-codex agent adopt --id research-1 --terminal t7 \
  --project /absolute/existing-project --thread EXISTING-CHAT-UUID \
  --scope read-only
```

Use actual native addresses. Adoption attaches an existing local process without launching, restarting, renaming, prompting, changing its model, or changing permissions. Add `--desk DESK --desk-project PROJECT-ID` for a Desk; the explicit project path must match its registered project. `--task TASK-ID` selects an existing active task in the same chat/project. Otherwise adoption creates a task record, not an agent. It does not apply a specialist definition or claim an existing business work item/job.

The original PID, address, argv, creation identity, cwd, parent and integration labels are checked. Another worker's registration or ownership labels cannot be overwritten. Herdr space/tab labels are preserved. Identical retries recover the same binding, including an uncertain label response. Changed bindings or replacement processes require reconciliation; closed work is never restarted.

`--scope write` is the conservative default and reserves the project against other integration writers. Use `--scope read-only` for explicitly assigned read-only work. **Scopes are coordination declarations, not retroactive sandbox changes.** An existing program retains its original filesystem/tool permissions; results report `sandboxEnforced: false`.

After adoption, `agent read`, `followup`, `message`, `interrupt`, `show` and notification handling apply. `agent recover` remains for plugin launches; repeat the original adoption to reconcile an incomplete registration. A process verified to have finished during adoption releases its reservation and produces runtime attention. Unknown outcomes retain reservations for inspection.

## Native children

```sh
herdr-codex agent children --parent research-1
herdr-codex agent adopt --id helper-1 --terminal t8 \
  --parent research-1 --task ACTUAL-TASK-ID \
  --project /absolute/existing-project --thread EXISTING-CHAT-UUID \
  --scope read-only
```

Discovery lists actual children of the verified parent without adopting them. Adoption verifies the real parent relationship, chat and Desk, and preserves Herdr's native child lifetime. A child can use another explicit project under its own task, or join its parent's task when the project/Desk bindings match. Unrelated terminals remain outside the bridge.

## Questions and results

The bridge observes working/settled, blocked/error and crash events for adopted workers. Programs reporting native status can wake Codex without a reporting helper. An already-idle terminal is a quiet baseline, not a completed task. Plain programs without status still produce exit attention; prose is not parsed as completion evidence.

The adoption result supplies a `workerConfig` path. An agent able to read that binding and execute the installed helper can send explicit reports from its native terminal environment:

```sh
HERDR_CODEX_WORKER_CONFIG=/absolute/returned/worker.json \
  /absolute/node /absolute/plugin/runtime/src/message-cli.mjs \
  --kind question --text 'Question, evidence and recommendation' \
  --idempotency-key decision-1
```

A report may attach raw worker evidence v1 with `--evidence-file /absolute/report.json`
in the same invocation. The evidence is validated and bound to the sending
worker/task before the outbox receipt is written; unknown fields, a mismatched
worker/task or an over-budget payload fail without writing anything. Evidence is
preserved as a worker claim and surfaced on reads under a separate
`worker-claims` label — never as verified fact. See `docs/evidence.md`.

Codex can supply this reporting instruction in a follow-up. Adoption does not inject it or grant access through an existing sandbox. A child must use its own binding, never an inherited parent configuration. Reports verify native identity; duplicate keys preserve their original receipt. Handle wakes with receive → decision/reply → ack.

Remote native commands remain accessible. Managed remote adoption is not enabled: machine identity, remote project reservations and notification forwarding need separate qualification. Never register a remote process as local or silently substitute a local address.

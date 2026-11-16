# Qualifying a native Herdr update

Native command access stays available independently of the integration's managed
features. `native` forwards Herdr core commands and `app` forwards native desktop
commands. A newly installed command does not need a new wrapper operation.
Place integration `--config /absolute/integration.json` **before** `native` or
`app`; everything after either command, including `--config` and `--`, belongs
to Herdr. Input, output and a caller-provided interactive terminal are inherited.

Before adopting a new core version, run the local behavioral checks:

```sh
herdr-codex runtime qualify --core-binary /absolute/raw/herdr-core --out /absolute/new-evidence-directory
herdr-codex runtime status
```

The supplied core must be an executable Mach-O binary on macOS. Do not pass an
`hc` shell launcher: launchers can override session/socket settings and silently
select a live installation. Other platforms are currently unsupported. The
qualifier preserves the selected executable’s original runtime/bundle location,
which macOS holder startup depends on. It checks the raw executable and SHA-256
immediately before and after every harness and fails if either changes. Do not
update the candidate during qualification: this detects changes but does not
claim to lock an external updater. No duplicate executable is retained.

Four harnesses run sequentially with unique local sessions, sockets, state and
synthetic project data. They cover native lifecycle wake events, managed
delegation and Desk bindings, adoption of existing native workers, and the
Desk execution runtime. They use
deterministic terminal fixtures, not models, private project sources or actual
Codex host messages. Each harness owns its core and cleans up its own terminals.
No production core is replaced, no installation is activated, and no scheduled
Codex checks are created.

The Desk runtime harness executes deterministic commands under their actual
macOS file grants, verifies command receipts and output hashes, restarts its
isolated bridge while a dependency is pending, and checks that work resumes
without duplicate terminals. It also checks disabled-by-default automations,
event deduplication, real authored-file notifications, interval service timers,
and disabled-trigger behavior after restart. Its evidence is
`desk-runtime/desk-runtime-native-report.json`; its bridge and core shutdown
must both be clean. These checks do not exercise a model or prove the quality
of a Goose recipe's reasoning.

`qualification.json` records the binary, integration/all four harnesses/fixture hashes,
subprocess results and summary hashes. A successful process exit alone is not a
pass: every harness must also report passing checks, no model calls and no host
dispatch, and its isolated core must exit with code 0 and no signal after a
confirmed stop. A nonzero or signal-terminated core fails qualification even if
the behavior checks passed. Logs remain beside the report on failure; each log is capped at 1 MiB
while excess output is drained. A five-minute fixture watchdog terminates only
that newly created harness process group if it hangs. This is a test watchdog,
not a production agent or inference-request limit. Inspect failure evidence and
cleanup before using a failed candidate.

`runtime status` reads the most recent qualification and checks its integrity,
the exact selected executable, referenced harness summaries, and current integration/test source hashes. It
reports stale evidence when any change. It does not activate a version or treat
old passing results as current. To compare another selected raw executable,
provide `runtime status --core-binary /absolute/raw/herdr-core`.

Qualification has explicit boundaries:

- Native desktop rendering and behavior are not qualified by the core fixture
  suite. Desktop command/schema discovery is a separate structural check.
- Remote hosts need their own qualification. A local pass does not establish
  remote lifecycle, identity or notification behavior.
- A fake host notification sink verifies local routing and deduplication. Actual
  idle-Codex wake delivery still needs a message received in the intended chat
  after that chat yields. Queue acceptance alone does not prove it.
- Raw native operations bypass managed request bookkeeping. Adopt a terminal
  explicitly before expecting integration-owned Desk tracking and wake routing.

Herdr's older `herdr` terminal TUI uses a different CLI and protocol. These checks
target the `hc` core plus the native desktop integration; TUI-only commands are
not silently translated into core commands.

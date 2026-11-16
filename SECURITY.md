# Security Policy

Herdr–Codex is a **macOS-first beta** (`0.11.0-beta.1`). It runs locally and operates
native Herdr workers through MCP; it does not bundle native binaries, model servers, or
credentials. Public source lives at
[github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex) (verified public).

## Supported versions

Only the latest published beta is supported for security fixes. Prerelease builds are
provided as-is and may change without notice.

## Reporting a vulnerability

**Do not** open a public issue containing exploit details, credentials, tokens, session
transcripts, or personal paths.

- If **private vulnerability reporting is enabled** on the repository (GitHub
  **Security → Report a vulnerability**), use that private channel.
- If it is **not enabled**, open a minimal public issue in the repository's
  [issue tracker](https://github.com/gfgdev/herdr-codex/issues) that says only that you have a
  security report and ask the maintainers to establish a private channel. Do not include
  sensitive detail in that issue.

Do not send secrets to any address that is not a verified maintainer channel, and never
paste API keys or tokens into issues, pull requests, logs, or documents.

## What to include

Once a private channel is available, include: the affected version, the platform, a
minimal reproduction, the observed impact, and whether any credential or local file may
have been exposed. Redact secrets and replace absolute paths with generic placeholders.

## Areas of interest

- Credential or secret leakage into logs, artifacts, or generated documents.
- Unsafe path handling (absolute/relative path escapes, traversal on snapshot or recipe
  paths).
- Unexpected command execution through recipe, runner, or automation inputs.
- Reuse of stale session or snapshot state across providers, models, or desks.
- Packaged-artifact integrity (unexpected files, private content, or broken links).

## Scope notes

Automation is disabled by default (`enabled: false`) and no scheduler or supervisor is
installed. The dormant compaction example is opt-in and not activated by this package.
Report issues in those areas only if you can show an actual reachable path.

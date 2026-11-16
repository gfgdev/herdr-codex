# Public source export — manifest and guide

This document defines what becomes the **public open-source repository** and what stays
local. It is written for the maintainer performing the export; it is **not** part of the
distributed plugin artifact.

- Destination repository: [github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex)
  — created and verified public by the maintainer.
- License: MIT (see [LICENSE](../LICENSE)).
- Export mechanism: stage only the reviewed paths below (for example
  `git add` with the [.gitignore](../.gitignore) exclusions in place). Do **not** publish
  the whole workspace recursively.

The three surfaces are different and must not be conflated:

| Surface | Contents | Who sees it |
| --- | --- | --- |
| **Public source export** | Reviewed source, tests, docs and policy files listed below | Anyone (GitHub) |
| **Distributed plugin artifact** | The builder output under `outputs/` (`plugins/herdr-codex/**`) | Share recipients |
| **Local-only evidence** | Raw qualification captures and private historical reports | This machine only |

## Included in the export

| Path | Notes |
| --- | --- |
| `package.json`, `plugin/`, `src/`, `scripts/`, `tests/` | Runtime, skills, launcher and test suite |
| `examples/`, `recipes/` | Documented Desk starters and the dormant compaction example |
| `README.md`, `CHANGELOG.md`, `CONTRACT.md` | Project overview, history and interfaces |
| `docs/` | All documentation **except** the exclusions below |
| `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `.gitignore` | MIT terms and policy |

`scripts/build-plugin.mjs` contains literal pattern strings (a home-directory prefix and a
workspace name); these are the **scanner patterns** the builder uses to reject private
content, not private data. They are intentionally part of the public export.

## Excluded from the export (preserved locally)

| Path | Why it is excluded |
| --- | --- |
| `inputs/` (incl. `inputs/qualification/*`, `inputs/goose-*.json`) | Raw, machine-specific qualification captures |
| `docs/local-herdr-direct-SKILL.md` | Contains personal absolute paths |
| `docs/reports/0.2.1.md`, `0.4.0.md`, `0.4.1.md`, `0.5.0.md`, `0.5.1.md`, `0.8.1.md` | Historical reports containing private machine paths |

Nothing listed above is deleted; the exclusions are recorded in [.gitignore](../.gitignore).
Historical source-control history is out of scope: the export starts from the reviewed
tree, and earlier commits are not rewritten.

The retained reports refer to the excluded ones as **plain historical text**, without a
relative link, so the exported tree contains no dangling references to local-only files.

## Two layouts for the same assets

The dormant compaction example exists under two directory names; both are internally valid,
and no document links across layouts:

| Layout | Path | Used by |
| --- | --- | --- |
| Source checkout | `recipes/compaction/` | `docs/recipe-catalog.md` as written in the repository |
| Distributed artifact | `plugins/herdr-codex/examples/compaction/` | The packaged copy of the same catalog |

`scripts/build-plugin.mjs` rewrites the catalog's `../recipes/compaction/` links to
`../examples/compaction/` while building, so the packaged document resolves inside the
artifact instead of pointing at a source-only path. The four assets themselves travel
byte-for-byte (see `tests/build-plugin.test.mjs`).

## Runnable checks in the export vs. recorded evidence

Be precise about which checks a reader can actually run after cloning.

**Runnable after clone (no external assets):**

- `npm test` — `node --test tests/*.test.mjs`.
- `node scripts/build-plugin.mjs --out /absolute/new/share-folder` — the reviewed builder
  (content scan, document links, packaged launcher help, packaged MCP tool discovery).
- The packaged launcher itself: `plugins/herdr-codex/scripts/herdr-codex.sh help`.

**Runnable only with an explicit external path (documented, not bundled):**

- `scripts/qualify-compaction-session.mjs` — set `PI_CODING_AGENT_DIST` to the installed
  Pi coding-agent dist entry.
- `scripts/qualify-goose-pi.mjs` and `scripts/goose-smoke.mjs` — set `GOOSE_BIN` (or put
  `goose` on `PATH`).

These harnesses make **no** claim about provider/model defaults and never print
credentials; the caller supplies provider/model through the environment.

**Recorded evidence only — not runnable from the export:**

- The Goose → Pi sampling artifacts described in
  [compaction-live-qualification.md](compaction-live-qualification.md) live under
  `inputs/qualification/`, which is excluded here. That document separates the
  development-checkout evidence from what the distributed artifact ships.

## Pre-export checklist

1. `npm test` passes (a sandbox that forbids Unix sockets reports environmental `EPERM`
   failures; re-run on a permissive host).
2. `node scripts/build-plugin.mjs --out <new path>` succeeds and prints `modelCalls: 0`.
3. No file in the export matches the builder's private-install or credential patterns
   (the builder enforces this for the artifact).
4. Version strings agree in `package.json` and `plugin/plugin.json`.
5. Repository links resolve to the verified public destination
   ([github.com/gfgdev/herdr-codex](https://github.com/gfgdev/herdr-codex)); no document
   still describes the repository as an unverified or provisional destination.

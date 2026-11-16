# Release operations research packet

Prepare an evidence-backed briefing using only `sources/`. The decision date is 2026-11-13. Do not contact anyone or browse external sources. This is a synthetic desk; there are no client credentials or documents.

Deliver `briefing.json` and `briefing.md` in your assigned outputs directory. The JSON must contain:

- `facts`: `retentionDays` (number), `approvalRequired` (boolean), `releaseWindowUtc` (`start`, `end`), `minRollbackVersions` (number). Each fact must be an object `{value, sources:["sources/file.md#section-id", ...]}`; for the window, `value` is the start/end object.
- `conflicts`: a list with `{field, oldValue, currentValue, sources, resolution}`. Explain superseding documents; do not merely choose the newest arbitrary note.
- `unresolved`: a list of `{question, sources}` for missing information.
- `recommendation`: `{enableAutomaticRelease:boolean, rationale:string, sources:[...]}`.

The Markdown should explain operational implications and trace facts back to sections, including contradictions. Distinguish the authoritative policy from observations and draft proposals. Do not invent an on-call owner, turn an unresolved question into a fact, or claim you contacted someone. Identify any decision that still belongs to the user.

# Warehouse manifest allocation

This small module imports a supplier's CSV manifest and allocates whole rows to a capacity. The existing export parser only supports uncomplicated data. The allocation policy is already selected: priority descending, stable input order for ties, skip rows that do not fit. Do not change that policy.

## Requested task

Improve `parseManifest(text)` so it safely handles real CSV exports. Keep its public API and all allocator behavior unchanged. Use only the Node standard library; add meaningful tests.

The exact header must be `id,units,priority` (quoted headers are valid). Accept LF and CRLF records, with or without a final newline. CSV fields can be quoted, contain commas or embedded LF/CRLF, and escape a quote as `""`. Reject bare quotes in unquoted fields, characters after a closing quote before a delimiter, and unterminated quotes. Do not silently trim quoted IDs. Preserve every ID character, including spaces/newlines, and require a nonempty ID. Duplicate IDs are rejected by exact string identity.

Every record must have exactly three fields. `units` is a canonical positive decimal safe integer (`1`, `2`, …). `priority` is a canonical nonnegative decimal safe integer (`0`, `1`, …). Reject whitespace, signs, fractions, exponent notation, leading zeroes and unsafe integers in numeric fields. Reject internal blank records; allow a single final record terminator. A header-only export is valid. Errors must be `Error` instances with useful messages and must not return a partial result.

Save a short verification report with changed files, actual tests and remaining limitations. Do not install packages or change allocation semantics.

Leave this task contract and package.json unchanged. Put implementation notes in a separate report.

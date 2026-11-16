# Reconcile incoming purchase-order records

This is a synthetic operations task with local fixture data, not an email connector or live spreadsheet. Read `policy.md`, `input/existing.json`, and `input/incoming.jsonl`.

Write `ledger.json`, `audit.json`, and `reconciliation.md` in the assigned outputs directory. Do not edit input files. Do not send emails or use outside systems. `ledger.json` is an array of the final PO records sorted by `poId`, each `{poId,revision,vendor,amountCents,currency,sourceId}`. `audit.json` is an object with a `decisions` array in input order; each `{sourceId,action,reason,poId}`. Actions are exactly `insert`, `update`, `duplicate`, `stale`, `quarantine`. Also include `totals` with `count`, `amountCents`, and `currency` for the final ledger. Every input line needs an audit decision.

Explain the policy decisions and unresolved quarantines in the Markdown report with input line references. Keep arithmetic in integer cents. A duplicate or stale record cannot overwrite an accepted revision. If you write a deterministic reconciliation script for reproducibility, place it in outputs too and report its actual exit and resulting checks.

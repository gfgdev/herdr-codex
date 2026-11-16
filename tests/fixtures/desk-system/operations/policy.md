# Approved reconciliation policy

Process incoming lines in their given order. Records are identified by `poId`; accept positive integer `revision`, nonempty `vendor`, nonnegative safe-integer `amountCents`, currency exactly `USD`, and nonempty `sourceId`. No coercion of numeric strings. Missing/invalid fields go to quarantine.

For a valid incoming record, an exact repeated `sourceId` and identical record is a duplicate. Reusing a `sourceId` with different content is quarantine. Compare revisions only after this source-identity check: a lower revision is stale; an equal revision with identical business fields is duplicate; an equal revision with different business fields is quarantine; a higher valid revision replaces the previous ledger record. A new valid PO is inserted. Rejected records never change the ledger. Existing ledger records count as already observed sources.

Final totals include only the final accepted revision of each PO. Retain all audit outcomes; do not resolve quarantine through guesses or contact a vendor. The accepted ledger is denominated in USD. Incoming records can contain invalid field values, including other currencies; quarantine those records instead of converting them.

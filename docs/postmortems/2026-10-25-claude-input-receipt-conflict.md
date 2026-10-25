# Claude input receipt proof conflict

2026-10-25 (PDT). Identical boot queued-attachment payloads at native lines 1158/1177 precede one matching removal at 1178. The receipt guard rejected duplicates; SDK 0.3.310 selects the last copy. The initiating duplication mechanism remains unknown.

**Decision — 2026-10-25:** accept only identical input UUID/delivery ID and complete attachment payloads, with one matching removal after every copy; select the last copy. Conflicts fail closed; committed receipts stay immutable. Consumed boot receipts acknowledge their operation, preventing later re-enqueue.

The unchanged original root passes the corrected adapter: all 3,854 prior public records, the existing receipt and 1,175 fingerprints remain intact; 14 records append using 1177/1178. Repeat scans, reopening and unrelated appends remain stable.

Separately authorized manual repair restored history without deployment. [Immutable full report](https://github.com/schani/pi-orb/blob/dd8219a333e7d7659b07b2097e6e4e56b8236ad6/docs/postmortems/2026-10-25-claude-input-receipt-conflict.md) preserves recovery, security containment and validation forensics.

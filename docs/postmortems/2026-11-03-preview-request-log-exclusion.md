# Preview request URLs retained despite the log exclusion (2026-11-03)

## Symptom

Live acceptance on `piorb.live` sent a request carrying a privacy marker in its query. Cloud
Logging retained it in `run.googleapis.com/requests` with the full preview URL and query, as it
did for every preview request since the 2026-11-03 deployment (81 entries during acceptance).
The `preview-requests` project exclusion existed and was enabled.

## Cause

The exclusion filter's regex used `\\.` for each literal dot. Terraform heredocs keep backslashes
literally, and Cloud Logging passes a quoted `=~` regex to RE2 without unescaping, so `\\.`
required a literal backslash and never matched. Read queries against the live entries confirmed
it: `piorb\\.live` matched 0 entries, `piorb\.live` matched all 81, and the corrected full
pattern still rejected `…piorb.live.evil`. The contract test modelled Logging as JSON-unescaping
the string, so it passed with the broken filter.

## Fix

The filter now uses single backslashes (`\.` and `replace(…, ".", "\\.")`). The contract test
renders the filter as Terraform does, applies it verbatim and rejects doubled backslashes.
Entries retained before the fix stay in `_Default` until its retention expires; they come from
test orbs only.

## Rule

Verify a log exclusion against real ingested entries with a read query before relying on it.
Do not infer Cloud Logging string escaping from another language's rules.

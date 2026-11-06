# Private plan output (2026-11-06, PST)

A recursive cache search emitted old private OpenTofu plans containing a database password, connection URL and password hash.
The documented tool tail contained no known secrets; the exact child AI input is unavailable, so model exposure is unknown.
Checks of the PR and three hosted receipts found none of the known values.
Offending work was stopped; private raw output is preserved with 0600 files and a 0700 directory.
Rule: research public sources in a separate cache. Parse explicit private files in memory and emit only allowlisted facts, never raw plans or recursive cache content searches.

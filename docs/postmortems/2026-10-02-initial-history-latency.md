# 2026-10-02 — Compact history still waits on whole-record loading

Read-only investigation of slow initial history for orb `b7e8855f-5315-4d5a-a81f-fa275e100b98`. No optimization was implemented or authorized; no production mutations or transcript-content inspection occurred.

## Measurements

The replica held 8,406 records: 61,429,143 bytes of full PostgreSQL JSON text, with a largest record of 2,132,323 bytes. The compact browser response was 3,187,988 bytes.

| Probe | Result |
| --- | --- |
| Three ops GETs: time to first byte | 1.153 / 1.387 / 1.725 s |
| Same GETs: remaining body transfer | 0.220 / 0.096 / 0.246 s |
| Recursive full-record `EXPLAIN ANALYZE` | 186–316 ms; 5,816 KiB disk sort |
| Identity-only ancestry | 77 ms; 713 KiB in-memory sort |
| `pg_column_size` aggregate | 19 ms |
| Full `record::text` aggregate | 650 ms; another sample 1.150 s wall |
| Text aggregate without top-level native `overflow` | 24,930,886 bytes; 392–434 ms |

Aggregate probes did not return or log record bodies. `EXPLAIN` excludes JSON output conversion: its execution time is not the complete database-read cost. Exact Node database parsing, display projection, response serialization and user-browser processing were not measured. Ops requests are not browser IAP qualification.

For these requests, most elapsed time preceded the first byte, rather than transferring the compact body. The browser projection still reads and parses complete records before discarding hidden content. This supports investigating database output and server preparation, but does not establish their individual shares or promise an end-to-end speedup.

A naive candidate walked IDs, joined records and selected `(record - 'overflow') ORDER BY depth`. It worsened `EXPLAIN` to 543 ms and the disk sort to 24,240 KiB, versus the existing 186–316 ms. Removing native payload alone is not sufficient: query shape and where wide values enter sorting matter. Pruning after ordering remains an unimplemented candidate, not a measured improvement.

## Provenance and scope

Production browser revision: `pi-orb-00075-h5n`; ops: `pi-orb-ops-00072-btw`. Older full-history revision logs showed approximately 60.7 MB / 3.03–4.14 s, versus current compact logs of 3.188 MB / 1.40–1.72 s; these are not controlled same-request comparisons.

Incarnation 9 was stopped and its GCE host `pi-orb-b7e8855f-5315-4d5a-a81f-fa275e100b98-i9` was `TERMINATED`. Its actual boot image was `pi-orb-image-v-6bd5d0a-48bb6f776e764cb0`, image ID `9129237180071143083`, created October 2 at 18:50:12 PDT. That image commit emits compact live records through `projectDisplayRecord`; an obsolete full-record live emitter is not supported as the explanation for this snapshot measurement.

## Resulting proposal

First separate database read, parse, projection, serialization and browser readiness with content-free phase measurements. Then evaluate a browser-specific projection-input read that prunes native overflow after ordering, preserving complete CLI and replication reads. No query or paging design was selected. The existing whole-history backlog owns this work (`TODO.md`); compact transport does not bound source reconstruction or browser summary count. Design context: `docs/history-replication.md`, `docs/transcript-cache.md`.

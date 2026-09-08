# A stale stopping marker rejected a restarted orb

**Date:** 2026-09-07  
**Impact:** The first terminal opened after a live native-VM stop/start closed immediately. The orb and its data remained healthy.

The ops process that accepted Stop recorded a process-local stopping marker and closed live connections. Reconciliation ran in another role, so only that role cleared its marker after reaching `stopped`. After Start committed a newer `running` episode, the original ops instance still rejected a terminal with close code 1013 and reason `orb is not running`. A later probe reached another instance and passed, which exposed the per-process disagreement.

Stopping markers now carry the durable orb `state_version` and remain monotone for the process lifetime. A proxy accepts a newer active episode, still rejects when a concurrent Stop marker is newer than the row it read, and cannot erase that newer marker when an older transition completes. Proxy regressions exercise both live and terminal sockets across these boundaries.

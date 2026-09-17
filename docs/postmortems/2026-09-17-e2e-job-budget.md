# E2E job exceeded its wall-clock budget

**Date:** 2026-09-17  
**Status:** Root-caused; workflow correction pending hosted validation

## Incident

GitHub E2E runs [35264000440](https://github.com/schani/pi-orb/actions/runs/35264000440) (`0e93ca1`) and [35270543609](https://github.com/schani/pi-orb/actions/runs/35270543609) (`9756e60`) were canceled at the job's 30-minute limit. GitHub killed Vitest, skipped failure-artifact upload, and produced no suite summary.

This was not a stalled test. Both runs made the same serial progress and passed every reported file. The final reported file was `orb-sleep.e2e.test.ts`, 30:16 after job start in the first run and 29:45 in the second. GitHub canceled each run before Vitest could report the remaining short files.

## Evidence

The last successful predecessor, [35240212552](https://github.com/schani/pi-orb/actions/runs/35240212552) (`758c625`), needed 28:02 of the 30-minute job budget. Its test step alone took 1,470.35 seconds.

Commit `c640d16` then added the serial `multi-user-credentials.e2e.test.ts`. In run [35242500576](https://github.com/schani/pi-orb/actions/runs/35242500576), that file passed in 123.8 seconds; the job reached 30 minutes before the remaining existing files completed. Commit `90924ac` later added two sleep files; the real-process case passed in 74.2 and 71.8 seconds in the two requested runs. Their repeated per-file timings and order differ only slightly.

Raw logs and run metadata are preserved outside Git under `.context/github-e2e-timeouts/`.

## Cause

The workflow runs all E2E files serially (`fileParallelism: false`) after dependency, browser, and runtime-image setup. Its 30-minute timeout covers setup and tests together. The suite's deterministic growth exceeded that fixed wall-clock budget; no individual test timeout fired.

The workflow comment described the test step's former duration as if it were the whole job and left too little capacity for additions.

## Correction

Raise only the GitHub job budget from 30 to 40 minutes. Individual test and hook deadlines remain unchanged. Sharding was rejected for this correction: it duplicates expensive setup and changes fixture concurrency when a larger job envelope directly matches the failure.

A healthy run should retain material headroom above observed setup and serial suite duration. Test additions must be assessed against the whole job, not only Vitest's reported duration. A job-budget cancellation with continued file completions is distinct from an individual test timeout; preserve and compare file progression before changing test deadlines.

# Missing Docker parent snapshot during local qualification — 2026-09-15

## Observation

The N1/C2/P1 implementation's full E2E run started at 2026-09-14 23:49:53 UTC. `e2e/full-slice.e2e.test.ts` failed in `beforeAll`, before its four scenarios: Docker successfully built the runtime layers and exported its manifests, then failed while unpacking the named image into the local image store.

```text
failed to prepare extraction snapshot "extract-888049571-Pt0U sha256:a413b24be138198f18dd9ac6fabb54934f7dfce2f1694e6837082240d73b36ed":
parent snapshot sha256:8d112b61352b602f2d484a4f6d71b15279bd9c7d4602ba7affd5bea105e6134c does not exist: not found
```

Docker was 29.1.3. Its daemon had been inactive and was started before qualification. The failing export named manifest list `sha256:a00f6a4969dd6f6c4316cccf682f801820a8b7fba7de9036d4bb1c03d2e11dec` and config `sha256:6de9461ddc7daefe57df6a94a99a5fe1ef09048f8a62796adb58c93302b942c9`. Private original output: `.context/subagent-ui-implementation/e2e-full.log` (explicit exit 1).

The rest of that same run continued: nine files / 106 tests passed, including real local subagent counts/reload, abort, interruption recovery, active archival, authenticated MCP, terminal retention and Chromium/WebKit phone behavior. Four full-slice tests were skipped because their setup failed. A later fixture build in that same run produced `pi-orb-runtime:dev` image `sha256:e64806eec65d360834401740041d00062eca62fc40c482b4cdd296be046acb38`, created at 23:51:28 UTC. That later success does not explain or clear the missing-parent failure.

## Boundary and rule

The observed failure is in Docker's cached image extraction, not an application assertion. Why the referenced parent snapshot was absent is not established; daemon inactivity and the earlier host reboot do not by themselves prove causation. No test timeout/assertion was weakened, no retry was added, and no shared Docker store or other service was deleted to obtain green.

A failed image export leaves qualification incomplete even when subsequent image builds succeed. Preserve the original missing snapshot identity, establish an owned clean build/store boundary or repair the identified corruption, then qualify the affected scenarios. This remains a release gate alongside the separate WebKit/native gates; repair work is tracked only in `TODO.md`. The requested frontend preview is local and is not a production deployment.

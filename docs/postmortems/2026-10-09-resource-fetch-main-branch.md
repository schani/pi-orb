# Central resource fetch assumed `main` — 2026-10-09

[Deploy 37942017348](https://github.com/schani/pi-orb/actions/runs/37942017348) on `783c87fe625956aaabe9d79a225487aa12947f2e` applied and activated, then failed the lifecycle smoke: release `r-1791555034-93bd68eb-13e7-4892-833c-10cfeb688a80`, outcome `applied-but-unvalidated`, `first-boot: runtime_failed: resource_acquisition_failed`. Fixture orb `64d02dbe-4fc8-4191-806f-59d9ed989878` was retained; its compute was discarded, data disk `pi-orb-data-64d02dbe-4fc8-4191-806f-59d9ed989878` remained.

[Deploy 38059954991](https://github.com/schani/pi-orb/actions/runs/38059954991) on `f8a0f1ef3a1ec8e45759005eecdcc02c3f70b968` (2026-10-10) failed identically: release `r-1791642791-fa4ee45d-0200-4670-9751-fbf9dfc46c74`, `applied-but-unvalidated`, retained fixture orb `94220572-1f4c-4634-a132-0addd9793766`. Revision `pi-orb-issuer-00049-95t` serves 100%.

## Defect and evidence

`GitResourceSource` (`apps/control-plane/src/adapters/git-resources/git.ts`), introduced with central Durable Pi (PR 57), fetched `refs/heads/main`. The smoke repository `https://github.com/octocat/Hello-World` has only `master`, so the fetch exited 128 (`couldn't find remote ref refs/heads/main`) before the VM was provisioned. `lifecycle:` log: `resources.acquiring` at 14:29:42.996Z, `resources.failed code=fetch` at 14:29:43.685Z, then `transition from=creating to=failed code=runtime_failed` at 14:30:38.441Z. Git stderr is not retained, so the log carries only `code=fetch`; the cause was reproduced locally. Every project whose default branch is not `main` was affected; production orbs on `main`-default repositories reached `resources.ready`.

## Correction and invariant

The fetch takes the remote's `HEAD`, matching the guest clone and `docs/control-plane-api.md` (initial checkout uses the default branch). The resource-acquisition regression test now uses a `master`-only repository; it failed before the change.

# Orb boot hooks

Two repository-owned executables, `.agents/setup` and `.agents/resume`, let a project prepare its own orbs unattended: install toolchains, restore per-orb state and authenticate clients before the first prompt. The convention matches Amp's (`docs/references/amp-orb-lessons.md`), so a repository written for Amp orbs works unchanged wherever pi-orb can honor the same contract. The step-by-step authoring guide is the `boot-hooks` skill (`apps/orb-runtime/skills/boot-hooks/SKILL.md`); paths, budgets and scrubbed variables come from `apps/orb-runtime/src/hooks/runner.ts`.

Trust: repository code already runs with the agent's authority, so a hook grants nothing new. It runs earlier than the first prompt, which is what makes unattended orbs useful and also lets a malicious commit take effect before anyone reads it. Both consequences are accepted; repositories should protect these paths like CI configuration.

## Decisions

1. **Same paths, same split as Amp.** Setup prepares compute and receives no identity; resume runs on every start, receives identity and must be quick.
2. **"Fresh compute" means a new host incarnation.** pi-orb has no snapshots (open question 14); it has immutable compute incarnations around a persistent workspace (`docs/lifecycle.md`). What setup installs into the image layer dies with the incarnation; what it writes under `$HOME` or the workspace survives. Setup therefore runs on the first boot of every incarnation. Rejected: setup on every boot (it may take 20 minutes) and gating on the script's content hash (Amp does not; scripts must be idempotent anyway).
3. **No identity during setup, enforced mechanically.** Setup starts with `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL` removed, so `pi-orb id-token` and the brokered `gh`/git credential helpers fail closed ("not inside an orb runtime"). On a first boot the incarnation's bearer hash may not be committed yet, so identity during setup would be racy anyway (`docs/credentials.md`). This stops tooling, not a determined script: the bearer stays in the runtime process environment, which a hook running as the same user (or via `sudo`) can read through `/proc`. That is authority repository code already has. Rejected: leaving the variables and documenting the rule; an unenforced rule is the one the next hook breaks.
4. **`PI_ORB=1`, never `AMP_ORB`.** Every orb process sees `PI_ORB=1`. `AMP_ORB` is never set, so Amp-only branches do not run.
5. **`sudo` ships in the images** so `sudo apt-get` scripts work (`docs/host-provider.md` covers the runtime user per provider). Process hosts inherit the developer's machine.
6. **Failure is visible and the orb still starts.** A broken hook must not make an orb unreachable, since the agent is the tool that fixes it.
7. **The control plane relays hook outcomes; it does not store them.** The status files and logs live in the orb's persistent home, the runtime restates the latest outcome in every health report, and the agent is told through its prompt. `stateDetail` derives from the latest health report in ephemeral `ControlState`, lost harmlessly on control-plane restart. While stopped, the control plane says nothing about hooks. Rejected: persisted `hook_failure_*` columns (added a crash-consistency invariant to describe compute that is not running). The durable record is the `lifecycle:` edge.
8. **No project-settings hooks and no services manifest.** Amp's pre-clone/pre-setup hooks need a project settings store pi-orb lacks; repositories put that work in `.agents/setup`. Long-running services are open question 43.

## Contract

### Discovery and execution

- The runtime looks for both files at the repository root after the checkout is in place; repository-free projects use the retained `<work-dir>/repo` (fresh workspaces have none). Each is optional.
- A present file must be executable; a non-executable one is a failure with reason `hook_not_executable`, never a silent skip.
- The file is executed directly (its shebang picks the interpreter) with cwd at the repository root and the persistent `$HOME`.
- At most one hook runs at a time; resume never starts before setup has finished or timed out.
- The runtime executes only these two paths and nothing named by hook output.

### Triggers

| Event | setup | resume |
| --- | --- | --- |
| Orb creation (first boot of incarnation 0) | yes | yes, after setup |
| Compute replacement (first boot of incarnation n+1) | yes | yes, after setup |
| Stop/start of a retained incarnation | no | yes |
| Runtime restart within an incarnation | no | yes |
| Repository change by the agent | no | no |

Setup completion is stamped durably in the workspace, keyed by `PI_ORB_HOST_INCARNATION`, so a runtime restart does not rerun it and a new incarnation always does. An edited hook takes effect on the next incarnation or when run by hand. Rejected: a `pi-orb` subcommand to rerun hooks; executing the file suffices.

### Environment

- Both hooks: the runtime's environment (`PI_ORB_WORK_DIR`, `HOME`, `PI_ORB_ID`, `PI_ORB_HOST_INCARNATION`, `PI_ORB_REPOSITORY_URL` (empty without a repository), the image `PATH`) plus `PI_ORB=1`, `PI_ORB_HOOK=setup|resume` and `PI_ORB_HOOK_ENV_FILE`. Network is whatever the provider allows.
- Setup lacks `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL`.
- Project secrets (`docs/credentials.md`) are fetched after setup returns and before resume starts: setup cannot see them; resume, native Claude, tools and terminals can. Their names join the env-file deny-list for that boot so the file cannot shadow a dashboard-managed value.

### The hook env file

A hook's exports die with it, and no shell in the orb reads a profile (Pi's bash tool runs `bash -c`, terminals run `bash --noprofile --norc`). Hooks hand variables to the agent by writing `$HOME/.pi-orb/env` (`PI_ORB_HOOK_ENV_FILE`). Rejected: `/etc/profile.d` and `$HOME/.profile`, which nothing reads; using them left the cloud-identity resume recipe silently broken.

- After setup and after resume's blocking window, immediately before the agent session exists, the runtime parses the file, restricts it to mode 600, and merges entries into its own `process.env`, which tool shells and terminals inherit.
- Terminals re-read the file at PTY spawn with the same parser and deny-list, recording nothing. A variable written after the boot merge (late resume, or the agent) reaches new terminals immediately and the agent's tool shells at the next start.
- Format: one `KEY=VALUE` per line; blank lines and `#` comments ignored; the value is literal (no expansion or escapes) apart from one optional pair of matching surrounding quotes; a repeated name keeps its last value. A shell-compatible parser is rejected: `$(…)` in a repository-written file must not be a code path.
- Runtime-owned names are ignored with one edge per refused name: `PI_ORB_RUNTIME_TOKEN`, `PI_ORB_CONTROL_PLANE_URL`, `PI_ORB_SKILLS_DIR`, `PI_ORB`, `PI_ORB_ID`, `PI_ORB_HOST_INCARNATION`, `PI_ORB_CLAUDE_RECOVERY_PROOF`, `PI_ORB_WORK_DIR`, `PI_CODING_AGENT_DIR`, `HOME`, `PATH` (`HOOK_ENV_DENIED` in `apps/orb-runtime/src/hooks/env-file.ts`). A hook rewriting `PATH` would break every later boot in a way that looks like a platform bug.
- An unusable line is skipped and reported by line number only, never content (it may be a credential); the rest applies. A missing file is a no-op.
- The file persists across stop/start and replacement and is never truncated by the runtime.

### Timing

- Setup blocks readiness. The runtime reports phase `setup_running`, shown as `stateDetail` while the orb stays `creating`/`starting`, and keeps reporting so a hung hook is distinguishable from a dead runtime. Setup has a 20-minute deadline measured by the runtime's injected clock; the control plane holds its boot deadline meanwhile (`docs/lifecycle.md`). Rejected: raising the global boot deadline to 20 minutes.
- On timeout the runtime kills the hook's process group, records `timeout` and continues to resume and readiness.
- Resume starts after setup and before the first turn. The runtime waits at most 10 seconds; after that resume continues in the background with output still captured, and is killed when the orb stops. A late resume's verdict is owned by a handle (`BootHookRunner.whenLateVerdictSettled`), not a detached promise.
- A background child that keeps the hook's stdout open keeps the hook running; setup then holds the boot until its deadline.

## Observability

- stdout/stderr go to `$HOME/.cache/pi-orb/logs/setup.log` and `resume.log`, overwritten per run and mirrored to the runtime's log stream.
- Beside each log a status file records outcome (`ok`, `failed` with exit code, `timeout`, `hook_not_executable`), incarnation, start/end time and the last output lines. `env.status.json` records the env file's path, applied names, refused names and one reason per unusable line; names only, never values.
- Health reports carry the latest outcome per hook. While the orb is `running`, the control plane shows a non-`ok` setup as `stateDetail` `setup_failed` with reason and log pointer, from per-process memory; a restarted control plane re-learns it from the next health report. Contrast `host_discard_error`, which is persisted because it records a control-plane decision about compute that may no longer exist.
- The control plane logs `setup-failed` / `resume-failed` with incarnation, reason, exit code and log path, never output, once per orb per incarnation; success logs nothing. A resume still running after 10 s is not an event.
- When the latest setup or resume did not succeed, native Claude's system prompt gains a short fragment naming the hook, outcome and log path; healthy boots add nothing. Central Pi receives hook reports through execution health; pinned context and first inference do not wait for hooks.
- The always-appended tool baseline names both files, the incarnation/start split, the identity split, the idempotency and executable rules and the log directory, so agents learn the convention without hitting a failure.

## Security

- A hook has the agent's authority and no more: same user, `$HOME` and network. The only difference is setup's missing identity.
- The bearer is never passed to a hook as an argument, file or prompt fragment, and log capture cannot record it (setup lacks it; resume's log is the script's own output).
- Generated non-secret configuration (for example an external-account credential file) belongs in the workspace or `$HOME`; nothing containing a secret may be committed.
- With hooks, cloud identity follows the split: setup ensures the client is installed, resume writes the external-account file, writes variables to the env file and runs `gcloud auth login --cred-file=…`. The `cloud-identity` skill emits exactly that plus a committed, secret-free `.pi-orb/gcp-external-account.json` (`docs/workload-identity.md`).

## Deterministic coverage

Runtime checkpoints `boot-hooks.status-before-write`, `.status-written`, `.stamp-before-write`, `.stamp-written`, `.setup-deadline-kill`, `.resume-window-expired`; control-plane checkpoints `boot-hooks.hold-before-anchor`, `.hold-anchored`, `.before-ready-after-setup`. Failpoints `hooks.status.write` and `hooks.stamp.write` sit behind the runtime's `HookFileStore` port (`apps/orb-runtime/src/testkit/failpoints.ts`); control-plane scenarios add `store.write`, `store.read` and `runtime.health`. Required invariants: setup is never skipped without a stamp; stamp, status file and health report agree after any crash; no orb fails while a live runtime keeps reporting setup inside the hold; each edge fires exactly once. A scenario asserting behavior after an unreachable restart must keep the runtime unavailable until that restart (`docs/postmortems/2026-09-16-release-validation-blockers.md`).

## Non-goals

Project-settings hooks; snapshots or cached prepared compute (open question 14); a services manifest or supervisor (open question 43); rerunning setup when the checkout or script changes.

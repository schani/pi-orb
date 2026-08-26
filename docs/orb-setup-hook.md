# Orb boot hooks requirements

> **Status:** Requirements accepted 2026-08-25; implemented. Resolves open questions 13 and
> 41 (`docs/open-questions.md`). This document defines two repository-owned hooks the orb runtime
> runs on the repository's behalf — `.agents/setup` and `.agents/resume` — so a project can
> prepare its own orbs unattended. The convention deliberately matches Amp's so a repository
> written for Amp orbs works in pi-orb unchanged wherever pi-orb can honor the same contract, and
> every divergence below is named and justified.

## Purpose

An orb is only useful unattended if the repository can prepare it: install the toolchain the
project needs, restore per-orb state, and authenticate clients — before a human types the first
prompt. Today every such step is redone by the agent or the human in each new orb, which is
exactly what the workload-identity flow ends with: the *trust* side of federation is permanent,
but the in-orb side (write the credential file, export three variables, log gcloud in with
`--cred-file`) has to be repeated per orb (`docs/workload-identity.md`). Amp solves this with
`.agents/setup`; pi-orb should solve it the same way.

The trust delta is smaller than it looks. Repository code already runs as the agent in every orb
with the same authority; a boot hook grants nothing new. It only moves the moment of execution
earlier than the first prompt — which is precisely what makes an unattended orb useful, and
precisely what lets a malicious commit take effect without anyone reading it. Both consequences
are accepted and stated, not hidden.

## Reference: how Amp does it

Source: [Customizing Orbs](https://ampcode.com/docs/orbs/customizing) and the surrounding Amp
docs, checked 2026-08-25. Amp has four hooks: two live in project settings outside the repository
(pre-clone, pre-setup) and two in the repository root:

| | `.agents/setup` | `.agents/resume` |
| --- | --- | --- |
| Runs | only when no matching project snapshot exists; a snapshot skips it entirely | after initial activation and on every wake |
| Order vs. agent | before the agent starts; the agent waits | after thread env and workload identity are applied, immediately before the agent |
| Blocking | fully, up to 20 minutes, then Amp stops it and starts the orb anyway | up to 10 s, then continues in the background while the agent proceeds |
| Credentials | **none** — "Setup does not receive personal or thread workload identity … Install the service client in setup, then authenticate it from `.agents/resume`." | thread environment, secrets, and workload identity available |
| cwd | repository root | repository root (inferred from Amp's example) |
| Output | `/home/user/.cache/amp/logs/setup.log`, overwritten per run; not shown in the thread | `/home/user/.cache/amp/logs/resume.log`, same |
| Failure | orb still starts; no snapshot is published, so a later fresh orb runs setup again; nothing surfaced beyond the log | not documented |
| Rules | executable, shebang honored, idempotent ("Amp may run either file more than once"), no long-running processes (services go in `.amp/services.yaml`) | idempotent; "Do not install dependencies in this hook" |

Context Amp provides: Debian 12, an unprivileged user with passwordless `sudo`, network, the
environment variable `AMP_ORB=1` inside every orb, and a base toolset (git, `gh`, Node, Python,
`agent-browser`, …). Snapshots are reused for up to 24 hours; changing `.agents/setup` does not
invalidate one by itself.

This repository's own `.agents/setup` (written under Amp, 2026-08-12) is a working example of
the convention: guarded on `command -v gcloud`, keyed off `AMP_ORB=1`, `sudo apt-get`, cwd as
repository root. It also shows the one thing Amp's docs say not to do — it registers gcloud's
`--cred-file` login from setup rather than from resume — which works only because the credential
file is a deferred executable source that mints nothing at setup time. Under this document that
half belongs in `.agents/resume`.

## Decisions (2026-08-25)

1. **Same paths, same split.** pi-orb runs `.agents/setup` and `.agents/resume` from the
   repository root, with Amp's roles: setup prepares compute and receives no identity; resume
   runs on every start, receives identity, and must be quick. A repository targeting Amp needs no
   change to target pi-orb, and vice versa, except where the base image differs.
2. **"Fresh compute" means a new host incarnation.** pi-orb has no snapshots (open question 14
   stays open); it has immutable compute incarnations and a persistent workspace
   (`docs/compute-replacement.md`). Anything setup installs into the container layer is lost with
   the incarnation and anything it writes under `$HOME` or the workspace survives, which is
   exactly Amp's snapshot boundary expressed in pi-orb's terms. Setup therefore runs on the first
   boot of every incarnation — creation and every compute replacement — and resume runs on every
   start, including stop/start of a retained incarnation. Rejected: running setup on every boot
   (Amp does not, and setup may take twenty minutes) and gating it on the script's content hash
   (Amp explicitly does not; an idempotent script must be safe to re-run anyway).
3. **No identity during setup, enforced mechanically.** The runtime starts setup with
   `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL` removed from its environment, so
   `pi-orb id-token` and the brokered `gh`/git-credential helpers fail closed there (exit 2,
   "not inside an orb runtime"). This is Amp's rule made unavoidable rather than advisory, and it
   has a pi-orb-specific reason too: on a first boot the incarnation's bearer hash may not be
   committed yet (`docs/credentials.md`, the boot retry window), so identity during setup would be
   racy by construction. Resume gets the full environment. Rejected: leaving the environment
   intact and documenting the rule — every process in the orb inherits the bearer (an accepted
   exposure), and a rule the tooling does not enforce is one the next `.agents/setup` breaks.
   The residual, stated plainly (2026-08-25, from the implementation review): this stops the
   tooling, not a determined script. The runtime is root and PID 1 still holds the bearer, so
   `cat /proc/1/environ` recovers it from inside setup. That is the same authority repository code
   already has (it runs as the agent), so it is not a new exposure — but "unavoidable" means
   *`pi-orb id-token` and the brokered helpers cannot succeed by accident*, not that the token is
   cryptographically out of reach. Closing the residual needs the unprivileged-user change
   (question 42) or a bearer that never sits in an inherited environment.
4. **`sudo` ships in the image; the runtime keeps running as root for now.** Amp scripts use
   `sudo apt-get …` throughout. The prescribed image has no `sudo`, and the runtime runs as root,
   so the cheapest full compatibility is installing `sudo` (a no-op elevation as root) rather than
   rewriting every script. Running the runtime as an unprivileged user with passwordless sudo, as
   Amp does, is a separate hardening decision (open question 42) and must not block this feature.
5. **`PI_ORB=1`, never `AMP_ORB`.** Every orb process sees `PI_ORB=1`, the analogue of
   `AMP_ORB=1`, so a script can branch on the platform. pi-orb does not set `AMP_ORB`: a script's
   Amp-only branch (Amp's identity CLI, Amp's helper paths) must not run here.
6. **Failure is user-visible and the orb still starts.** Amp starts the orb regardless and hides
   the failure in a log file. pi-orb keeps "still starts" — a broken setup script must not make
   an orb unreachable, since the agent is the tool that fixes it — but the observability rule in
   `AGENTS.md` forbids the silent half. See "Observability" below.
   **The control plane relays the failure; it does not store it (amended 2026-08-25).** The fact
   is runtime-owned: the status file and the log live in the orb's persistent `$HOME`, the runtime
   restates the latest outcome in every health report, and the agent is told through its
   prompt fragment. So `stateDetail` is derived from the latest health report exactly the way
   `waiting_for_runtime` is — ephemeral `ControlState`, re-learned on every poll, lost harmlessly
   on a control-plane restart. Rejected: the three `hook_failure_*` columns the first
   implementation added (migration `011_boot_hooks.sql`, now removed with no replacement). They
   bought nothing the runtime does not already hold, and they cost a crash-consistency invariant
   ("all three move together") and its coverage. What they *looked* like they bought was a verdict
   visible while the orb is stopped — but that is the one moment the verdict is worthless: it
   describes compute that is not running, and the view suppressed it anyway. While the orb is
   stopped the control plane therefore says nothing about hooks; the log stays in the workspace,
   and the truth is re-established from the runtime on the next start. The durable half of the
   observability rule is met by the `lifecycle:` edge, which is unchanged.
7. **No project-settings hooks, no services manifest.** Amp's pre-clone/pre-setup scripts live in
   project settings; pi-orb has no per-project settings store yet, so they are out of scope, and
   a repository that needs them declares the work in `.agents/setup` instead. Long-running
   services (`.amp/services.yaml`) are a separate question (43).

## Requirements

### Hook discovery and execution

- The runtime looks for `.agents/setup` and `.agents/resume` at the repository root after the
  checkout is in place. Each is optional. A present file must be executable; a present,
  non-executable file is a setup failure with a distinct reason (`hook_not_executable`), not a
  silent skip, because the difference between "forgot `chmod +x`" and "no hook" must be visible.
- The file is executed directly, so its shebang chooses the interpreter, with cwd set to the
  repository root and the runtime's persistent `$HOME`.
- The runtime runs at most one hook at a time and never starts resume before setup has finished
  or timed out.
- `sudo` is present in the prescribed image. A process host provider orb inherits the host's
  executables and privileges; whether `sudo` works there is the developer's machine's business,
  and the hook documentation says so.

### Triggers

| Event | setup | resume |
| --- | --- | --- |
| orb creation (first boot of incarnation 0) | yes | yes, after setup |
| compute replacement (first boot of incarnation n+1) | yes | yes, after setup |
| stop/start of a retained incarnation | no | yes |
| runtime restart within the same incarnation (unreachable-restart, drain restart) | no | yes |
| repository update by the agent | no | no |

The runtime records "setup has completed for this incarnation" durably in the workspace, keyed by
`PI_ORB_HOST_INCARNATION`, so a runtime restart within an incarnation does not re-run setup and
a new incarnation always does. A hook the agent edits takes effect on the next incarnation or
when the agent runs it by hand; both scripts are re-runnable on demand and must be idempotent
(Amp's rule: "A person or agent should be able to run it again without damaging the
environment"). Rejected: a `pi-orb` subcommand to re-run hooks — executing the file is enough.

### Environment

- Both hooks: the runtime's ordinary process environment (`PI_ORB_WORK_DIR`, `HOME`,
  `PI_ORB_ID`, `PI_ORB_HOST_INCARNATION`, `PI_ORB_REPOSITORY_URL`, `PATH` with the image's
  toolchain) plus `PI_ORB=1` and `PI_ORB_HOOK=setup|resume`.
- Setup additionally has `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL` removed
  (decision 3). Resume has them. Neither hook receives Tailscale material.
- Network is available to both, subject to whatever egress the host provider allows the orb.
- Nothing a hook exports persists into the agent's environment by itself. A hook that needs the
  agent to see variables writes them where the agent's shells read them (the repository's own
  convention, or `/etc/profile.d` as this repository's Amp script does) — matching Amp, where
  setup writes files and the environment is not inherited.

### Timing and blocking

- Setup blocks orb readiness: the runtime reports a distinct readiness phase (`setup_running`)
  and the control plane shows it as a user-visible `stateDetail` while the orb stays in
  `creating`/`starting`. Setup has its own deadline of **20 minutes** (Amp's value), measured by
  the runtime with an injected clock; the control plane's ordinary boot deadline must not fire
  while the runtime is reporting `setup_running`, and the runtime must keep reporting so a hook
  that hangs is distinguishable from a runtime that died. Rejected: extending the global boot
  deadline to twenty minutes for every orb.
- On timeout the runtime terminates the hook's process group, records `setup_timeout`, and
  continues to resume and readiness (decision 6).
- Resume is started after setup and before the agent session accepts its first turn. The runtime
  waits at most **10 seconds** (Amp's value); if resume is still running it continues in the
  background with its output still captured, and the agent proceeds. A resume that is still
  running when the orb stops is terminated with it.

### Observability

Per `AGENTS.md`: decisions of autonomous machinery must be reconstructable from durable places,
and outcomes that affect the user must be visible in the product.

- stdout and stderr of each hook go to `$HOME/.cache/pi-orb/logs/setup.log` and
  `resume.log` in the persistent home, overwritten per run, and mirrored to the runtime's own
  log stream so the operator can read them without an orb shell.
- The result of the latest setup run — outcome (`ok`, `failed` with exit code, `timeout`,
  `hook_not_executable`), incarnation, start and end time, and the last lines of output — is
  persisted next to the log as a small status file **in the orb**, and reported to the control
  plane in the runtime's health/readiness report. The control plane keeps the latest reported
  verdict in per-process memory and surfaces it as a user-visible `stateDetail` on the orb page
  (`setup_failed`, with the reason and a pointer to the log) while the orb is `running`. It is
  relayed, never stored (decision 6): the runtime owns the fact, the control plane caches its
  last answer, and a control-plane restart simply re-learns it from the next boot's health
  report. Unlike `host_discard_error`, which *is* persisted because it records a decision the
  control plane itself took about compute that may no longer exist, this verdict is a property of
  a live orb that keeps repeating it. Success is silent in the product.
- The control plane logs one `lifecycle:` edge per non-`ok` outcome (`setup-failed` with
  incarnation, reason, exit code — never output content) and nothing on success, per the
  edges-not-levels rule in `docs/lifecycle.md`. Resume failures follow the same shape with a
  `resume-failed` edge; a resume still running after 10 seconds is not an event.
- The agent is told. When the latest setup or resume did not succeed, the runtime appends a
  short system-prompt fragment (the mechanism `docs/pi-adapter.md` uses for the tool baseline and
  port exposure) naming the hook, the outcome, and the log path, so the first thing the agent can
  do is fix its own environment. A healthy boot appends nothing.
- The agent is also told that the convention *exists*, which is a different requirement (added
  2026-08-25): the always-appended tool baseline (`apps/orb-runtime/src/pi/environment-prompt.ts`)
  carries three sentences naming both files, the once-per-incarnation / every-start split, the
  identity split, the idempotency and executable rules, and the log directory. Without it an agent
  that never hits a failure never learns it could write one. The baseline has room for the
  convention only; the authoring guide is the `boot-hooks` skill (below, 2026-08-26).

### Security and trust

- A hook runs with the same authority as the agent and no more: the same user, the same
  `$HOME`, the same network. The only thing it cannot do that the agent can is act with the orb's
  identity during setup (decision 3).
- Hooks never receive, and must never be handed, the runtime bearer as an argument, a file, or a
  prompt fragment; the log capture must not be fooled into recording it (it is absent from
  setup's environment and resume's log is the script's own output).
- The runtime executes only the two named paths and never anything named by a hook's output.
- The consequence that a commit to `.agents/setup` runs on the next fresh orb of every project
  member without review is documented in the user-facing hook docs, with the recommendation that
  repositories protect that path like CI configuration.

### Idempotency and generated files

- Both hooks must be safe to run repeatedly; the canonical pattern is Amp's
  `if ! command -v X >/dev/null 2>&1; then …; fi`. The runtime documentation states that setup
  runs again after every compute replacement and that resume runs on every start.
- Generated non-secret configuration (an external-account credential file, a project config)
  belongs in the workspace or `$HOME`, both persistent; whether it is committed is the
  repository's choice. Nothing a hook generates that contains a secret may be committed; the
  workload-identity flow keeps this true by construction, since its credential file contains no
  secret (`docs/workload-identity-recipes.md`).

## Interaction with workload identity

With the hooks in place the `cloud-identity` skill's "future orbs" step becomes Amp's split:
`.agents/setup` ensures the client is installed (`gcloud` is already in the image; other clients
install here), and `.agents/resume` writes the external-account file, exports the variables
where the agent's shells read them, and runs `gcloud auth login --cred-file=…` — the step that
needs the orb's identity and therefore cannot live in setup.

**Done 2026-08-26.** `apps/orb-runtime/skills/cloud-identity/SKILL.md` emits exactly those two
files plus a committed, secret-free `.pi-orb/gcp-external-account.json` template, replacing the
"commit a script the next orb's agent runs by hand" guidance and the note that automatic execution
was pending. `apps/orb-runtime/skills/boot-hooks/SKILL.md` is the authoring guide for hooks in
general — the split, the budgets, the idempotency pattern, the log and status paths, and worked
examples — since the tool baseline has room for the convention only. Both are pinned by
`apps/orb-runtime/src/pi/skills.test.ts`, which reads the paths, budgets, and scrubbed variable
names out of `apps/orb-runtime/src/hooks/runner.ts` rather than restating them, and which requires
that no setup example authenticates anything.

## Using the hooks

Put either file at the root of your repository, make it executable, and give it a shebang.

| | `.agents/setup` | `.agents/resume` |
| --- | --- | --- |
| Runs | first boot of every compute incarnation — orb creation and every compute replacement | every start: creation, stop/start, and every runtime restart, always after setup |
| Blocks | the orb, for up to 20 minutes; then its process group is killed and the orb starts anyway | up to 10 seconds; then it keeps running in the background while the agent proceeds, and is killed when the orb stops |
| Identity | **none** — `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL` are removed, so `pi-orb id-token`, the brokered `gh`, and the git credential helper all fail | full: install the client in setup, authenticate it here |
| cwd | repository root | repository root |
| `$HOME` | the orb's persistent home; what you write there survives replacement, what you install into the image layer does not | same |

Both hooks get the runtime's environment (`PI_ORB_WORK_DIR`, `HOME`, `PI_ORB_ID`,
`PI_ORB_HOST_INCARNATION`, `PI_ORB_REPOSITORY_URL`, the image's `PATH`) plus `PI_ORB=1` and
`PI_ORB_HOOK=setup|resume`. Neither gets Tailscale material. `PI_ORB=1` is set for every process in
the orb, so a script shared with Amp can branch on it; `AMP_ORB` is never set. Nothing a hook
exports reaches the agent — write to `/etc/profile.d` or your project's own convention instead.
`sudo` is installed in the prescribed image (the runtime is root, so it elevates nothing); a
process-provider orb inherits the developer's machine and may not have it.

Output goes to `$HOME/.cache/pi-orb/logs/setup.log` and `resume.log`, overwritten on every run and
mirrored into the runtime's log stream. Beside each log a `*.status.json` records the outcome
(`ok`, `failed` with the exit code, `timeout`, `hook_not_executable`), the incarnation, the start
and end times, and the last lines of output. A hook that did not succeed is shown on the orb page
and told to the agent; a healthy boot says nothing anywhere.

Both hooks must be idempotent — setup runs again after every compute replacement, resume on every
start, and a person or the agent may run either by hand. The canonical pattern is Amp's
`if ! command -v X >/dev/null 2>&1; then …; fi`. Do not start long-running services from a hook.
A hook is finished when its output is finished: if you must leave something running, redirect its
output (`… >/dev/null 2>&1 &`), because a background child still holding the hook's stdout keeps
the hook open, and setup will hold the boot until its twenty-minute deadline kills the group.

**Review these files like CI configuration.** A commit to `.agents/setup` runs unattended, with the
agent's authority, on the next fresh orb of every project member, before anyone reads the diff.

## Non-goals

- Project-settings hooks (Amp's pre-clone/pre-setup) — no settings store exists.
- Snapshots or any caching of prepared compute (open question 14).
- A services manifest or supervisor for long-running processes (open question 43).
- Running the runtime as an unprivileged user (open question 42).
- Re-running setup automatically when the checkout or the script changes.

## Deterministic coverage (2026-08-25)

Named checkpoints mark the crash boundaries, following the `compute-replacement.*` convention in
`docs/compute-replacement.md`:

```
boot-hooks.hold-before-anchor        control plane, before the setup hold anchor is (re)seeded
boot-hooks.hold-anchored             control plane, after it
boot-hooks.before-ready-after-setup  control plane, before the ready transition that ends a held boot
boot-hooks.status-before-write       runtime, before a hook's status file is written
boot-hooks.status-written            runtime, after it
boot-hooks.stamp-before-write        runtime, before the incarnation stamp is written
boot-hooks.stamp-written             runtime, after it
boot-hooks.setup-deadline-kill       runtime, before setup's process group is killed at its deadline
boot-hooks.resume-window-expired     runtime, when resume outlasts its blocking window
```

Failpoints: `store.write` / `store.read` (control plane, existing vocabulary), `runtime.health`
(control plane, existing), and `hooks.status.write` / `hooks.stamp.write` — a new group in the
runtime's own testkit (`apps/orb-runtime/src/testkit/failpoints.ts`) behind the `HookFileStore`
port, which exists so a refused disk is a schedule a scenario can choose.

Three defects the coverage found, all fixed on the same branch:

1. **The create/start deadline was decided on evidence the process did not have.** A control-plane
   restart during a running setup hook lost the in-memory hold anchor, and the ordinary deadline was
   evaluated at the top of the very first reconcile pass — before any probe. A healthy orb whose
   twenty-minute hook was still working was failed `deadline_exceeded` immediately. Fixed: the
   deadline waits until the runtime has actually *answered* this process (a cancelled or refused
   probe is not evidence either — the first fix, which waited only for any recorded probe, still
   failed under a schedule where a late-firing operation deadline cancelled the first health call),
   bounded by `unreachableBootDeadlineMs` so an orb whose runtime is genuinely gone still fails on
   its own deadlines.
2. **A backgrounded resume's late verdict had no owner.** The continuation that records the outcome
   of a resume hook that outlived its blocking window was a detached `void promise.then(...)`
   writing files after the boot coroutine had ended — the native-promise hazard in `docs/testing.md`.
   It now has a handle (`BootHookRunner.whenLateVerdictSettled`) that a simulated owner awaits;
   nothing in the boot path waits for it.
3. **The world modeled a dishonest setup start time.** `FakeWorld` timestamped a finished hook at
   the health poll that noticed it, not at the moment the runtime spawned it — and that number is
   exactly what the hold reseeds from after a process restart, so the reseed path was never really
   exercised. The model now derives both timestamps from the runtime's own start.

## Verification requirements

- Runtime unit tests behind a process-spawner port and an injected clock: discovery
  (absent / present / present-but-not-executable), the setup environment scrub, the incarnation
  stamp (setup once per incarnation, resume every start), the 20-minute timeout with process
  group termination, the 10-second resume blocking window with background continuation, log
  capture and overwrite, the status file, and the health-report and prompt-fragment outputs for
  every outcome. The tool baseline names both hooks, the identity split, the idempotency and
  executable rules, and the log directory.
- Runtime DST (`apps/orb-runtime/src/hooks/runner.test.ts`): `setup-hook-timeout`,
  `resume-hook-background`, `resume-hook-shutdown`; a restart-within-the-incarnation sweep
  `boot-hooks-runtime-crash-{status-before-write, status-written, stamp-written,
  setup-deadline-kill, resume-window-expired}` — the next runtime process re-runs setup exactly
  when the stamp did not land, always re-runs resume, and ends with stamp, status file, and health
  report agreeing; and `hook-writes-under-fs-failpoints`, which runs two boots of one incarnation
  with both durable writes failing at random and requires that a setup is never skipped without a
  stamp and that the health report carries the verdict a refused disk did not.
- Control-plane DST (`apps/control-plane/src/domain/boot-hooks.dst.test.ts`): `setup_running`
  readiness holds the boot deadline off (`setup-holds-boot-deadline`), is bounded
  (`setup-hold-is-bounded`), and is distinguishable from a silent runtime
  (`setup-then-silence-fails`); `setup-failed`/`resume-failed` edges fire once per outcome
  (`setup-failed-still-runs`, `setup-failed-per-incarnation`); the orb still reaches `running`
  after a failed or timed-out setup (`setup-timeout-still-runs`); compute replacement re-runs
  setup on the new incarnation (`setup-per-incarnation`). Races: `setup-hold-across-restart`,
  `stop-during-setup`, `spec-change-during-setup`, `idle-stop-never-preempts-setup`,
  `runtime-restart-runs-resume-only`. `setup-hold-across-restart` doubles as the relay test: its
  setup fails, so the second process must show `setup_failed` it learned from the runtime, with
  nothing durable carrying it across the death. Crash windows, each restarting the control plane
  on the durable state a death at the named checkpoint leaves behind:
  `boot-hooks-crash-{hold-anchored, hold-reseeded, failed-setup-across-death}`.
  Failpoints: `setup-hold-under-store-failpoints` (`store.write`/`store.read`) and
  `setup-hold-under-health-failpoints` (`runtime.health`), both requiring that no orb is failed
  while a live runtime keeps reporting setup inside the hold, that the relayed verdict still
  reaches the orb page, and that each edge still fires exactly once.
- E2E (Docker backend): a fixture repository with both hooks proves the ordering
  (setup → resume → agent), that `pi-orb id-token` fails inside setup and succeeds inside resume,
  that a failing setup surfaces on the orb page and in the agent's context while the orb runs,
  and that stop/start runs resume only while replacement runs both. `npm run test:e2e` gates the
  change as usual, since it touches the runtime boot path.

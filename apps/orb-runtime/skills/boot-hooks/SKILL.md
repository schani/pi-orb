---
name: boot-hooks
description: Write, fix, or debug this repository's `.agents/setup` and `.agents/resume` — the two executable files pi-orb runs before the agent, so future orbs of the project come up with the toolchain installed and its clients authenticated. Use when a human asks to make future orbs have something installed or configured, to set up the repository's orb environment, to make a setup step automatic or reproducible instead of repeated per orb, or asks why a boot hook failed or did not run.
---

# Repository boot hooks

You are running inside a pi-orb orb. This repository can prepare its own orbs
with two executable files in its root, which the runtime runs before you get
your first turn. Write them once, commit them, and every future orb of this
project comes up prepared.

| | `.agents/setup` | `.agents/resume` |
| --- | --- | --- |
| Runs | once per compute incarnation: orb creation and every compute replacement. Never on stop/start | every start, after setup, before your first turn |
| Waiting | the orb waits, up to a 20-minute deadline; then its process group is killed and the orb starts anyway | the orb waits 10 s, then continues while the hook keeps running in the background |
| Identity | **none** | full |
| cwd | repository root | repository root |
| For | installing toolchains, packages, caches | authenticating clients, restoring per-orb state |

## The identity split is mechanical, not advice

The runtime removes `PI_ORB_RUNTIME_TOKEN` and `PI_ORB_CONTROL_PLANE_URL` from
setup's environment. So inside `.agents/setup`, `pi-orb id-token`, the brokered
`gh`, and the git credential helper do not merely violate a convention — they
fail, with "not inside an orb runtime". **Install in setup, authenticate in
resume.** There is no way around it and no reason to want one: setup's work
survives in the image layer only until the compute is replaced, while resume
runs on every start, which is exactly when a credential needs refreshing.

## What a hook can rely on

| Variable | Value |
| --- | --- |
| `PI_ORB` | always `PI_ORB=1`, in every orb process, so a script can branch on the platform. `AMP_ORB` is never set |
| `PI_ORB_HOOK` | `setup` or `resume` — the same file can serve both if you symlink it |
| `PI_ORB_ID` | this orb's ID |
| `PI_ORB_HOST_INCARNATION` | the compute incarnation; it changes when compute is replaced |
| `PI_ORB_WORK_DIR` | the persistent workspace root |
| `HOME` | the orb's persistent home — what you write there survives compute replacement |
| `PI_ORB_HOOK_ENV_FILE` | `$HOME/.pi-orb/env` — the only way to give the agent a variable |

Plus the image's `PATH` and `PI_ORB_REPOSITORY_URL`. Neither hook gets Tailscale
material. Network is available to both.

Both files are executed directly, so the shebang chooses the interpreter and the
executable bit must be committed (`git update-index --chmod=+x .agents/setup`).
A present but non-executable hook is reported as a failure, not skipped.

## Rules

- **Idempotent.** Setup runs again after every compute replacement, resume on
  every start, and a human may run either by hand. Guard everything:
  `command -v X >/dev/null 2>&1 || install_x`.
- **No long-running processes.** A hook is finished when its output is finished;
  a backgrounded child still holding stdout keeps the hook open, and setup will
  hold the boot until its deadline kills the group. If you must leave something
  running, redirect its output: `… >/dev/null 2>&1 &`.
- **`sudo` is in the prescribed image** (the runtime is root, so it elevates
  nothing). An orb on the process host provider inherits the developer's machine
  and may not have it — guard rather than assume:
  `if command -v sudo >/dev/null 2>&1; then sudo …; else …; fi`.
- **Nothing a hook exports reaches your shells** — and neither does
  `/etc/profile.d` or `$HOME/.profile`. Your bash tool runs `bash -c` and the
  Terminal tab runs `bash --noprofile --norc`; no profile is read by either.
  Write `$PI_ORB_HOOK_ENV_FILE` instead (below).
- **Never write a secret into the repository.** Non-secret generated
  configuration (an external-account file naming a helper, a project ID) is fine
  to commit; anything that is itself a credential belongs under `$HOME`, which is
  persistent and not the checkout.
- **Review these files like CI configuration.** A commit to `.agents/setup` runs
  unattended, with your authority, on the next fresh orb of every project member,
  before anyone reads the diff.

## Giving the agent environment variables

Append `KEY=VALUE` lines to `$PI_ORB_HOOK_ENV_FILE`. Right before your session is
created — after setup and after resume's 10-second window — the runtime merges
that file into its own environment, which every bash tool call and every
terminal inherits.

```sh
umask 077
{
  printf 'GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$HOME/.pi-orb-gcp.json"
  printf 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1\n'
} >> "$PI_ORB_HOOK_ENV_FILE"
```

The format is the whole format: one `KEY=VALUE` per line, `#` comments and blank
lines ignored, the value literal — no `$VAR` expansion, no escapes — apart from
one optional pair of matching surrounding quotes, and a repeated name keeping its
last value. Expand in the hook, as the `printf` above does, not in the file.

- The file lives in `$HOME`, so it survives stop/start and compute replacement.
  Nothing truncates it for you: rewrite it rather than appending if a value
  should change, or a stale line will outlive the reason for it.
- These names are the runtime's and a line naming one is ignored:
  `PI_ORB_RUNTIME_TOKEN`, `PI_ORB_CONTROL_PLANE_URL`, `PI_ORB_ID`,
  `PI_ORB_HOST_INCARNATION`, `PI_ORB_WORK_DIR`, `HOME`, `PATH`, `PI_ORB`,
  `PI_ORB_TAILSCALE_AUTH_KEY`, `PI_ORB_TAILSCALE_HOSTNAME`,
  `PI_ORB_PREVIEW_HOST`.
- An unusable line is skipped, reported by number in `env.status.json` and in
  your own context, and the rest of the file still applies.
- A resume hook still running past its 10-second window writes too late for this
  boot. Its variables arrive on the next start — so keep anything the agent
  needs immediately inside the window.

## Where the output goes

```text
$HOME/.cache/pi-orb/logs/setup.log           stdout+stderr, overwritten per run
$HOME/.cache/pi-orb/logs/setup.status.json   outcome, incarnation, times, last lines
$HOME/.cache/pi-orb/logs/resume.log
$HOME/.cache/pi-orb/logs/resume.status.json
$HOME/.cache/pi-orb/logs/env.status.json     which variables the env file gave you
$HOME/.pi-orb/env                            the env file itself
$PI_ORB_WORK_DIR/.pi-orb/setup-incarnation   the incarnation whose setup already ran
```

A hook that did not succeed is shown on the orb page and appended to your own
context with its outcome and log path. A healthy boot says nothing anywhere.

## Example: install a tool in setup

```sh
#!/usr/bin/env bash
# .agents/setup
set -euo pipefail

if ! command -v shellcheck >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y shellcheck
fi

# Warm a cache in $HOME, which survives compute replacement.
npm ci --prefer-offline
```

## Example: authenticate a client in resume

```sh
#!/usr/bin/env bash
# .agents/resume
set -euo pipefail

# The orb's own identity, minted fresh on every start. Never write it to a file
# in the repository and never echo it under `set -x`.
token=$(pi-orb id-token --audience 'https://api.example.internal')
printf 'machine api.example.internal password %s\n' "$token" > "$HOME/.netrc"
chmod 600 "$HOME/.netrc"
```

For the GCP case — external-account file, three exported variables, and
`gcloud auth login --cred-file=…` — do not invent it here: read the
`cloud-identity` skill, which writes both hooks for you.

## Checking why a hook failed

```sh
cat "$HOME/.cache/pi-orb/logs/setup.status.json"
tail -50 "$HOME/.cache/pi-orb/logs/setup.log"
```

The status file's `outcome` is one of `ok`, `failed` (with `exitCode`),
`timeout` (it exceeded the 20-minute deadline and its process group was
killed), or `hook_not_executable` (`chmod +x` it). Its `incarnation` says which
compute the verdict describes.

## Re-running by hand

```sh
./.agents/setup
./.agents/resume
```

That is the whole mechanism — the runtime just executes the file. Editing a hook
does not re-run it; setup runs again on the next compute incarnation, resume on
the next start. To make the runtime re-run setup on the next restart within this
incarnation, remove its stamp:

```sh
rm -f "$PI_ORB_WORK_DIR/.pi-orb/setup-incarnation"
```

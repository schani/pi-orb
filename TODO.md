# TODO

Actionable work items: bugs, hardening, and agreed follow-ups (see `AGENTS.md`):

- An item lives in exactly one place — here or in `docs/open-questions.md` (undecided design questions), never both.
- This file is the only backlog: no TODO/FIXME comments in code, no TODOs buried in design prose. Design docs link here.
- When an item is done, delete it here and record the outcome in the relevant design doc.

## Bugs

## Hardening

- **Recover from a crash-looping runtime container** (same incident; the reporting half shipped 2026-08-06 — the GCE startup script publishes container status/restart-count/last-exit-code to the `pi-orb/container` guest attribute and `diagnose` folds it into boot-failure evidence, `docs/host-provider.md`). Two pieces remain. (a) DST-test the evidence shaping: a fake provider whose `diagnose` returns crash-loop evidence, asserting the `runtime_never_answered` terminal error carries it. (b) A crash-looping container whose image layers may be corrupt (hard stop mid-pull) should trigger image re-pull as recovery instead of failing the orb — the reporter now makes that condition detectable.

- **Close the served-vs-durable persistence gap** (was open question 33; incident: `docs/postmortems/2026-08-03-cursor-not-found.md`). The runtime answers history pulls from in-memory session entries while the SDK persists with `appendFileSync` and no fsync, and the SDK loader silently drops a truncated tail line on reload. A hard host stop can therefore lose a record the control plane already replicated and committed as its cursor, stranding the orb in a `cursor_not_found` integrity failure. Candidate fixes: serve only durably-persisted entries (fsync barrier or persisted-watermark cursor), fsync at drain time, and/or make the loader surface a truncated tail as a load error instead of silence.
- **Abort the GCE startup script when the data-disk mount fails** rather than bind-mounting an empty directory as `/workspace` (from the same incident).
- **Refuse to silently create a fresh session when the control plane already holds replicated history** (from the same incident).
- **Operator replication-reset escape hatch** — recovery from an integrity-`failed` orb today is a new orb (from the same incident).
- **Make the unreachable-runtime decision measure and corroborate actual runtime silence** (incident: `docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`, defects a+b). Today `silent_ms` is "time since last pull success", so time spent waiting on a slow GCE observe — pull attempts are serialized behind a 60 s `observe host for pull` — counts as runtime silence, and a control-plane egress blip reads as a dead runtime; the 2026-08-05 incident hard-stopped a healthy runtime mid-turn without having sent it a single request during the measured silence. Candidate fixes: base the baseline on pull *attempts that reached the runtime* rather than successes-only, and require corroboration before restarting (e.g. hold off while provider API calls are themselves failing/slow — a failing observe means "my egress is broken", though a successful `RUNNING` observe proves nothing per the livelock postmortem).

## Follow-ups

- **Standalone re-login action** (was open question 31): repair a mid-run credential revocation without stopping and starting the orb (`docs/credentials.md`; today recovery is stop/start).
- **exe.dev verification spike** (prerequisite for open question 35; `docs/EXE-DEV.md`): a $20 account and a half-day — boot the runtime image with `new`, hit port 8080 through the proxy with an HTTP and a WS client using a locally minted VM token, halt the VM from inside and watch what `ls` reports, then `restart` and confirm `/workspace` survived.
- **Tier-2 port exposure: `tailscale serve` promotion** (`docs/ports.md`): per-port opt-in HTTPS at `https://pi-orb-<orbId>.<tailnet>.ts.net` — enable tailnet HTTPS certs, run `tailscale serve` from the runtime on request, switch the control-plane URL builder to the `https` form for promoted ports. Prerequisite for embedding previews in the web UI (mixed content) and for Funnel sharing.
- **Revoke an orb's Tailscale auth key and remove its tailnet device on orb deletion** (`docs/ports.md`): nothing deletes orbs today, so nothing revokes keys or cleans up device records; when orb deletion exists (open question 27), fold both into it.
- **Detect and resume a turn interrupted by a host restart** (incident: `docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`, defect c). On boot, after loading the session, the runtime can detect an interrupted turn from the persisted session tail (trailing tool result, or assistant tool calls with no closing text) — today it silently comes up idle and the user's task just stops. Candidate fix: append a visible "turn interrupted by restart" marker record and self-issue a continuation prompt (pi has no resume API, but a synthetic `prompt()` resumes fine since the partial turn is in context). Guards: at most one auto-resume per interruption (persisted marker), or a restart-inducing turn loops forever burning tokens and VM hours; never resume silently — the marker record must land in history.

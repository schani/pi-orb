# Lessons from Amp's “Putting an Agent in an Orb”

Primary reference: [Putting an Agent in an Orb](https://ampcode.com/notes/putting-an-agent-in-an-orb), Thorsten Ball, July 2, 2026. Related reference: [Amp Orbs manual](https://ampcode.com/manual/orbs).

We do not need to copy Amp's implementation, but several lessons directly inform pi-orb.

## Relevant Amp choices

Amp currently:

- uses one fresh orb per thread;
- uses Debian 12 with a broad prescribed toolset;
- clones the repository automatically;
- runs repository-owned `.agents/setup` on fresh creation;
- runs a fast, idempotent `.agents/resume` on wake;
- snapshots a prepared sandbox and reuses it for up to 24 hours;
- pauses inactive orbs after 15 minutes;
- supports project environment variables, secrets, and short-lived OIDC workload identity;
- provides authenticated “portal” URLs for services running in an orb;
- provides a supervised service declaration (`.amp/services.yaml`);
- provides sync back to a local checkout;
- makes ports discoverable through generated metadata instead of hardcoding;
- centralizes logs, including browser console output, in an agent-readable location;
- invests heavily in layered `AGENTS.md` guidance, idempotent scripts, structured health/preflight endpoints, seeded users, and development-only authentication helpers.

Amp uses tmux for shared terminal/process workflows. pi-orb has explicitly chosen not to use tmux for its UI.

## Design lessons to retain

The strongest lesson is not a particular VM API; it is **do not make the agent guess**.

Potentially applicable ideas:

- a fixed, well-documented base environment;
- short, idempotent setup and restart-repair hooks;
- snapshots/prebuilds after setup;
- a structured readiness/preflight endpoint that explains failures;
- generated port/service metadata;
- centralized, greppable logs including browser diagnostics;
- easy development-only authentication paths for applications under test;
- authenticated web portals to services inside an orb;
- short-lived workload identity instead of long-lived cloud credentials;
- supervised declared services rather than ad hoc detached processes;
- explicit source synchronization back to the user's checkout;
- rich `AGENTS.md` guidance near the code it describes.

These are inspirations and open design inputs, not committed first-slice features.

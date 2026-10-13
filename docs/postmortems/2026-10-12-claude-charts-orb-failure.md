# Claude charts Orb initialization failure — 2026-10-12

[Orb 7f3476f4-ea60-4d32-89d3-de31efb8fa8b](https://pi-orb-issuer-1077475695242.us-central1.run.app/orbs/7f3476f4-ea60-4d32-89d3-de31efb8fa8b). PDT: operation completed at 9:02:22 PM; initialization failed at 9:02:36 PM; VM disposal completed at 9:02:54 PM. The charts-skill inbox request remained `delivering`. Earlier unresponsiveness had exhausted five automatic restarts/hour.

Retained evidence contained only a generic initialization failure; no replicated initialization diagnostic survived. Source at `94d6884` discarded SDK exceptions and stderr. The original cause is unknown, not proven to be authentication, charts code or session corruption. Read-only disk attachment was denied for missing `compute.instances.attachDisk`; no disk was attached, permissions changed or recovery performed.

Sources: committed transcript, Orb detail/inbox, Cloud Logging lifecycle/deletion records and GCE disk inventory. The resulting rule is in `docs/claude-agent-sdk.md`: preserve bounded, redacted initialization details in the user error and lifecycle log before disposal.

# Claude steering receipt failure: c9a30a6d

2026-10-15, America/Los_Angeles (PDT). Read-only disk inspection established a normalization defect, not missing native consumption. Orb `c9a30a6d-afb3-4a51-a979-335ae7ac389e`; session `37bd751f-1e28-4848-9416-9623480e4020`; CLI `2.1.300`; deployed runtime image version `v-1f11f218` (image metadata, not the orb's repository checkout).

## Correlated evidence

| PDT / one-based root line | Evidence |
| --- | --- |
| 15:23:01.749 | Inbox `394adec7-bbde-4d98-bb11-dd90c7165e4d`: “And in the top right there should only be a \"go to dashboard\" button.” Dispatched as steering at 15:23:02.532. |
| 15:23:02.522 / 1178 | Root `attachment/queued_command`, UUID `0d60ebf1-0218-4dc8-8ec9-40d1142977ea`; `source_uuid=f2d396f5-37a3-442f-bb56-e863b974eb45`, `delivery_id=d482db7d-9d5e-48e0-a2c7-1b6863928264`; prompt matches inbox. Saved ledger/provenance associate that input with operation `34517c36-97c0-4352-8567-ef821f8e48ad`. |
| 15:23:02.795 / 1179 | Same-session `queue-operation remove / absorbed_mid_turn` matches **both** `commandUuid` and `deliveryId`: consumption proof, unlike attachment presence alone. |
| 15:23:02.910 / 1183 | Request `b166b178-709f-4550-8553-d236b458c8e5` includes instruction-blob hash `72bf807a353f20f69ef91430804a2a69a761cb0095c3e4c57e3d106f815c908f` in `tail`; construction evidence, not provider acceptance. |
| 15:28:03.639 / 1300 | Last replicated request event. Replica ends at native line 1304; later local records are absent from it. |
| 15:28:15.555 / 1306 | Retained final reply `4416551b-b3da-4b1e-ab33-0d8f0550fb74`, `stop_reason=end_turn`, confirms the change and published HTML. Provider request `req_011Cg4p1HSYPqZRrnnq4byTt`, requestRef `a75e9a67-63a9-412b-a679-5025e1d88c2f`, message `msg_011Cg4p1L4ny9AYbmKcpo4QQ`. |
| 15:28:53.683 / local index | Steering result records that input answered, no pending inputs, zero queued turns. Query `9fb0f7bd-251d-4020-bfd1-36ee9791c64a`; same operation. Successful 17-turn handoff follows at 15:28:54.281. |
| 15:29:05.334 | Drain fails `claude_delivery_uncertain`: no durable normalized receipt. Compute deletion follows, not precedes, failure. |
| 15:31:33.859 | Replacement startup rejects the same submitted input; automatic replay remains disabled. Replacement discarded; orb remains failed. |

Six other inbox inputs have ordinary UUID receipts and are delivered; this input remains delivering. `submitted:true` persists before SDK enqueue and is not consumption proof. The normalizer at `1f11f218:apps/orb-runtime/src/claude/history.ts` chose top-level UUIDs and reduced attachments/removals to identity-only events. It lost nested input identity and inbox correlation. Drain and restart's exact-ID checks therefore rejected an input the native session had consumed. Successful result echoes corroborate the incident but cannot independently authorize receipt or replay.

## Correction and limits

**Approved decision — 2026-10-15; local, undeployed:** append an existing-schema `claude.input_receipt` event from the proven pair plus saved provenance, including already fingerprinted roots. Never rewrite old records/native bytes or replay input. Full contract and boot-position rationale: `docs/claude-agent-sdk.md`; qualification: `docs/testing.md`.

The unreplicated final tail, five earlier reachability restart cycles, and exact process exit code/signal remain unexplained. No separate provider rejection or SDK crash is established. No native debug/exit logs were found; deleted-VM journald is unavailable. Published result: https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/c9a30a6d-afb3-4a51-a979-335ae7ac389e/analyst-onboarding-redesigns-v4.html

## Preservation

Disk `pi-orb-data-c9a30a6d-afb3-4a51-a979-335ae7ac389e`, ID `6171680811230466435`, was attached READ_ONLY to disposable inspector `forensic-c9a30a6d-224244` (no service account/external IP), kernel read-only, mounted `ro,noload,nodev,nosuid,noexec`; no journal replay or target code execution. Selected projections excluded authentication/config payloads. Unmounted, detached at 15:48:20.086; inspector/boot disk deleted. Target disk remains READY without users; orb state unchanged. No target restart, replay, repair, acknowledgement, IAM change or deployment.

Private raw evidence, projections, scripts, transport checksums and cleanup records remain in `/workspace/evidence/c9a30a6d/`, especially `disk-forensics/`. These local files are not durable published artifacts. Original SHA256s: root JSONL `269cfd076b4ae8652136c6546878281cacc84a3c3bc7bebe7aa57569d686bc3e`; index `90f21d45194dfbb90303ae391b132594b1171e17a28dc4b4429310db19de8df7`; provenance `bb95fa5ff6bad3588583053098c2a6505d4e441ae156bf4853947dadb93a02f2`; ledger `718331f264b5d526ad1000b3b18d7fdac95c87d01756edac69ab5292985746bf`.

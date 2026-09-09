# Workspace uploads

## Selected behavior (2026-09-08; implementation 2026-09-09)

The orb header uses **U1 Tray arrow** for upload and **L2 Solid transport** for Start/Stop, selected in `design-prototypes/orb-header-icons.html`. Upload appears only for a running orb. Server admission independently enforces running state; uploading never starts compute. Start/Stop retain their existing lifecycle behavior and accessible action names.

**Picker flow revised 2026-09-09:** the header icon opens the browser's native multiple-file picker directly. Choosing files starts their uploads immediately; cancelling the picker does nothing. The intervening “Upload to orb” modal and second Upload confirmation were rejected as unnecessary steps. Files upload independently, with sequential chunks within each file. A compact inline strip below the header shows only unfinished transfers, pending notifications, and errors, with per-file pause/retry/cancel controls. Successful/cancelled rows disappear; the inbox/transcript is the sole lasting upload receipt. The composer draft is untouched.

Files land under `/workspace/uploads/`, beside `/workspace/repo`, not in the checkout or the published-file namespace. Each transfer owns `/workspace/uploads/<transfer UUID>/<original filename>`. The UUID directory preserves the original filename while preventing collisions, including two simultaneous files with the same name. This replaces the initial proposed `name-2.ext` naming algorithm: deterministic ownership is simpler to retry and clean up than allocating suffixes under concurrent requests. These files follow ordinary workspace retention: Stop/replacement retains them; archive/delete removes them. Nothing is extracted, executed, converted, or published by the transfer system.

**One notification per picker selection (decided and implemented 2026-09-09):** file byte transfers remain independent, but all files selected together belong to one immutable batch. Exactly one ordinary inbox message lists the batch's successfully published paths and sizes:

```text
The user uploaded files:
- "/workspace/uploads/<UUID>/input.bin" (12345 bytes)
- "/workspace/uploads/<UUID>/notes.txt" (42 bytes)
```

A one-file batch retains the singular `The user uploaded a file to …` wording. The initial implementation's per-file notifications were chosen to simplify partial-success recovery, but rejected by the user because selecting several files must not generate several agent messages. Membership is now registered atomically before any file bytes are sent. Notification waits until every member is stored or explicitly cancelled. A failed/paused member remains retryable and holds the notification pending; cancelling it allows one final message containing only the successful files. An entirely cancelled batch sends no empty message. Separate picker selections remain separate batches. File contents never enter the message; the agent can read them using its usual tools. The inbox starts an idle agent or steers a busy one. The earlier context-only/no-turn proposal was rejected at the user's request because it requires additional adapter scheduling and recovery machinery.

Upload notification enqueue uses `wake: false`, under the existing inbox transaction's orb row lock. If Stop wins, the queued content survives but neither enqueue nor subsequent upload recovery requests startup. A separate running-state precheck followed by ordinary wake-capable enqueue was rejected because Stop could race the two operations. The normal dispatcher delivers the message after explicit startup. The batch UUID is the inbox message UUID (the browser uses the selection's first transfer UUID). Paths are ordered by transfer UUID, so the notification body is immutable across concurrency, retries, and recovery. Already-notified members remain part of that same body after a crash during per-file marker updates; existing inbox deduplication prevents another message. A finalized file with an unaccepted notification stays `stored`, with a visible notification-pending outcome.

## Streaming and persistence

```text
Browser File.slice (at most 4 MiB)
    → authenticated browser HTTP endpoint
    → control-plane streaming proxy
    → runtime HTTP stream
    → immutable chunk files on the workspace disk
    → bounded streaming assembly + SHA-256
    → atomic, no-replace publication
    → existing durable message inbox
```

No file bytes are put in PostgreSQL, base64, a WebSocket, a whole-file `arrayBuffer`, or a whole-request body parser. Both HTTP servers install a raw streaming parser for `application/octet-stream`. Node fetch forwards the incoming stream with backpressure; the runtime awaits disk writes before consuming more data. The browser sends native Blob slices, not copied byte arrays. Assembly and hashing use bounded file streams (64 KiB reads). There is no global concurrency admission machinery, as requested: per-transfer buffering is bounded, while total memory necessarily scales with actual concurrent work.

The 4 MiB request size is below Cloud Run's HTTP/1 request-size limit and bounds the impact of request-buffering intermediaries. This is not a claim that browser, IAP, or Cloud Run internals never buffer a request. Platform behavior and memory still require live validation; local tests cannot establish those properties. No whole-file or per-orb quota is selected beyond the protocol's safe-integer size representation. Remaining resource policy is question 59 in `docs/open-questions.md`.

Metadata lives in `workspace_uploads` (migrations `016_workspace_uploads.sql` and `017_upload_batches.sql`), owned by the orb through an `ON DELETE CASCADE` foreign key. It retains transfer identity, batch identity, filename, declared size, incarnation, committed offset, status, destination, SHA-256, active-until timestamp, last error, creation time, and update time. Bytes and small filesystem commit markers live on the workspace, never in this table.

Batch registration holds the orb row lock and inserts every member in a single transaction. Retries must match the complete original identity/name/size set; membership cannot grow or shrink. No timing window, browser-only completion counter, or opportunistic inbox coalescing defines a batch. The simulation adapter models registration as the same atomic persistence boundary, with scheduling checkpoints and store failpoints. Batch IDs, member states, paths, and errors make the reason for a pending notification durably queryable.

Runtime staging is `/workspace/.uploads/<UUID>/`. The manifest binds identity to filename and size. Each chunk is streamed into an exclusive temporary file, flushed, renamed to `<offset>.chunk`, and followed by a directory flush **before** acknowledgement. Only contiguous committed chunks contribute to the resumable offset. Interrupted `.partial` files are ignored and removed by the next operation under that transfer's serialized queue. Retries query the runtime's committed offset rather than blindly append a possibly accepted request.

Completion streams the committed chunks into an exclusive assembly file, computes SHA-256, flushes it, and publishes with a hard link that cannot replace an existing destination. The destination directory and completion metadata are flushed. Replay verifies existing destination bytes instead of overwriting; status can reconstruct completion after a crash between publication and its marker. Completed staging chunks are removed; cancelled transfers persist a tombstone so a delayed request cannot recreate them. Directory creation also flushes parent entries. These filesystem guarantees have real adapter tests; the domain fake does not pretend that an ordinary write is automatically durable.

Per-transfer queues serialize chunk/status/finalize/cancel mutations, not independent uploads. Runtime requests carry an incarnation header and reject a different incarnation. Control-plane metadata writes fence the orb's current incarnation and destructive states; a completed notice can be acknowledged after replacement because its file is retained workspace state.

## HTTP surface

Browser endpoints:

- `GET /api/v1/orbs/:orbId/uploads`: persisted transfer outcomes, including for stopped orbs.
- `POST /api/v1/orbs/:orbId/uploads`: atomically register one selection with `{ id: batchId, files: [{ id, name, size }, …] }`; running only and immutable membership. Returns an array of transfer views, each including `batchId`. The metadata-only JSON body has a 1 MiB limit; file bytes use the separate streaming endpoints.
- `GET /api/v1/orbs/:orbId/uploads/:id/status`: reconcile offset or completion with the runtime.
- `PUT /api/v1/orbs/:orbId/uploads/:id/chunk?offset=N`: raw bytes, known `Content-Length`, at most 4 MiB.
- `POST /api/v1/orbs/:orbId/uploads/:id/finish`: persist finalization intent, publish the file, and enqueue the batch notification only if every member has a terminal file outcome.
- `DELETE /api/v1/orbs/:orbId/uploads/:id/cancel`: remove uncommitted bytes and persist cancellation.

The runtime mirrors actions at `/v1/uploads/:id/:action`, with bounded metadata in the query and `x-orb-incarnation` in the request header. It is on the same private control-plane/runtime boundary as the existing runtime protocol. The browser never connects to it directly. Returned progress is schema-checked at each adapter boundary.

Transfer states are `transferring → finalizing → stored → notified`, with `cancelled` for unpublished transfers. `notified` means the message inbox durably accepted the notification, not that the agent already processed it; the transfer row retires into the ordinary inbox/transcript presentation. Completion intent is persisted **before** the runtime can publish. Running reconciliation checks incomplete finalization and retries inbox acceptance independently of the browser. A failed finalization is visible and does not renew a lease on every reconcile pass: subsequent status checks can discover publication, while an incomplete transfer can be retried explicitly. This avoids an unreachable/failed upload pinning compute forever.

The browser keeps the original immutable `File` objects for same-tab retry. Reload/navigation aborts active browser requests, not already committed bytes. The inline strip reloads persisted unfinished outcomes; a browser-reloaded incomplete upload can be cancelled and the file selected again as a new transfer. It does not resume different local bytes merely because name and size match. The message draft is independent and unchanged.

## Idle protection, explicit Stop, and observability

An admitted transfer owns a five-minute renewable activity lease. Every chunk/status/admission refreshes it; a browser/runtime HTTP operation has a two-minute deadline, and runtime assembly has a bounded read deadline. The lease covers inter-chunk gaps, slow sources/sinks, and finalization independently of tab visibility or agent activity. No model-busy event or streaming cursor is fabricated.

`upload_active_until` on the orb is the maximum active transfer lease. Admission/renewal and terminal updates lock the orb row, update this projection, and refresh `last_busy_at`. Admission from an unprotected/expired interval and terminal release also advance the state version without changing lifecycle state or `state_changed_at`; ordinary progress within an active interval does not churn that version or unnecessarily conflict with explicit Stop. The idle-stop CAS checks the projection in its own update; the version advance invalidates stale decisions made before admission or release. Unlike ordinary model-activity touches, upload activity deliberately advances this fence to close the admission/idle-CAS race. No additional lifecycle state is introduced. Explicit Stop/archive/delete do not consult the idle-only guard and can interrupt a transfer.

Terminal outcomes release protection and refresh the idle anchor. The idle anchor also includes the projected lease expiry, giving an abandoned transfer a fresh idle interval when its protection ends. An abandoned lease expires, so disconnected browser metadata cannot keep compute running indefinitely; its committed staging bytes remain until explicit cancellation or workspace destruction. Expiry is not cancellation and does not prove that bytes were never accepted. Error/status timestamps and the persisted lease projection make transfer protection and user outcomes queryable without per-chunk stdout logging. Unfinished transfer outcomes and errors remain inline below the orb header; notification/inference outcomes use the ordinary inbox and transcript surfaces.

## Validation

**Local results (2026-09-09):** the batch revision passed the full unit/DST suite (1,525 tests, 5 skipped), infrastructure checks, repository lint/typecheck, and all 10 frontend Chromium tests. The process-backed full-slice primary scenario also passed with two selected files, one inbox message, agent-side checksum verification, and sidecar reading. The other three full-slice scenarios were not rerun for this revision; the initial implementation's complete process-backed E2E run passed 13 tests with 2 Docker/PostgreSQL-only skips. This is not a production deployment or evidence of Cloud Run/IAP buffering behavior.

- DST executes production upload recovery/notification coordination and store semantics under scheduled admission, stop, replay, expiry, and incarnation/deletion races. Invariants include no duplicate notification, no upload-driven compute wake, no idle-stop winning after admitted activity, and explicit Stop retaining authority. The upload lease and wake-suppression store contract runs against the simulation store and PGlite (and PostgreSQL when that suite is enabled).
- Runtime filesystem tests cover binary chunks, short chunks/partial transfers, ignored crash debris, lost chunk acknowledgements, immutable metadata, zero-byte files, completion replay, no-replace publication, and publication-before-marker recovery. These establish the real durability-adapter contract behind the coordinator's modeled effects.
- A real TCP test streams through **both** HTTP servers into actual runtime storage, compares binary bytes, observes a single ordinary inbox message, and checks stopped-orb/incarnation rejection.
- Chromium fixture E2E checks native picker activation, automatic upload without a dialog/confirmation, actual 4 MiB + trailing-slice bytes received by the server, gated inline finalization progress, retirement after completion, draft preservation, running-only visibility, inline failures with same-identity retry, and a second selection completing while an earlier transfer is explicitly held. The batch revision adds a two-file selection with one failed chunk: no premature message, one registration, same-batch retry, and exactly one notification containing both paths. All ten frontend browser tests passed.
- Full-slice E2E selects a binary file and a text sidecar together in Chromium for an actual Pi runtime; one notification makes the model invoke `sha256sum` and read the sidecar. Its scripted response requires both the expected digest and the sidecar marker, and the inbox must contain just one upload notification listing both paths. Runtime changes retain the `npm run test:e2e` deployment gate.

Batch validation caught an undeclared SQL array parameter at the adapter boundary; the batch query now uses `arrayParam`, and both simulation and PGlite contracts pass. The existing deletion DST test also needed to persist its stored outcome before testing notification rejection: batch notification reads durable membership/outcomes rather than trusting a fabricated caller snapshot. The failing `upload-expiry-fencing` trace was replayed before this test correction and remains in `test-failures/`.

Initial validation caught two test-authoring defects, not product races: incorrect `SimulationTask.sleep` arguments (recorded/replayed traces remain under `test-failures/upload-*`), and using Playwright's abbreviated request headers to inspect browser-added Content-Length. The latter initially awaited the complete header value. Adding request interception to deterministically hold finalization for the direct-picker UI test exposed that even this view omits browser-added Content-Length under routing. The test now measures each chunk from the server's acknowledged byte count minus its requested offset, preserving the exact-size assertion rather than relying on intercepted header metadata. Neither was cleared by an unchanged passing rerun. The first full-slice run verified the uploaded bytes but exposed a later ordered mock-script failure; its diagnosis and explicit inference barrier are recorded in `docs/postmortems/2026-09-09-upload-e2e-script-order.md`.

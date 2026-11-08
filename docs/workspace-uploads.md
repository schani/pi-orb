# Workspace uploads

Users upload arbitrary files from the browser into a running orb's workspace. Files land under `/workspace/uploads/`, beside `/workspace/repo`, and the agent hears about them through one ordinary inbox message per selection. Uploads never start compute.

## Browser UI

**Picker.** The header's tray-arrow Upload icon (`Upload files`) appears only while the orb is running. It opens the native multiple-file picker; chosen files start uploading immediately and cancelling the picker does nothing. Rejected: an "Upload to orb" dialog with a second confirmation (no decision to make), a composer clip (confuses files with model attachments), a workspace drawer, `/upload` and a drop-only entry.

**Progress.** A compact strip in the orb header stack (`File transfers`, polite live region) shows only unfinished transfers, pending notifications and errors, with per-file controls. It stays pinned on desktop and outside the phone transcript scroller, so scrolling cannot hide an active outcome. Finished and cancelled rows disappear; the inbox/transcript message is the only lasting receipt. The composer draft is never touched.

**Drag and drop** (`apps/web/src/components/orb-file-drop.ts`).
- Dropping files on the transcript uploads them exactly like one picker selection: one drop is one batch.
- Dropping images on the composer attaches them to the unsent draft, through the same validation path as paste. Non-images there show `Non-images can only be uploaded as files to the orb.`; mixed drops attach the images and reject the rest. Nothing is ever silently uploaded elsewhere.
- A non-running orb rejects every file drop with `Uploads need a running orb.` anywhere in the orb view; dropping never starts compute.
- Files dropped outside a destination never navigate the browser. Native text and link drags are unaffected; file-drag cancellation clears feedback without intercepting them.
- **Fine inset:** during a file drag only, a dashed 1px boundary 8px inside the receiving surface, a translucent white wash and a centred white-backed caption (`Upload files to orb`, `Attach images to message`). It clears on exit or drop. The transcript inset is fixed and out of flow: on desktop it covers the bounded transcript pane between header stack and composer; on phones, the scroll pane. Blank desktop transcript space hit-tests as the transcript; header and sidebar are not drop targets.
- Browser-local rejections create no upload record; admitted drops use the normal durable outcomes.

**Controls and ownership.** The page keeps the original immutable `File` objects for retry while mounted.
- A transfer with an active local request shows **pause**.
- An inactive local transfer that still holds its `File` shows **retry** and **cancel**.
- A persisted transfer with no local owner shows **cancel** only.
- Reload, navigation or unmount aborts owned requests (not committed bytes); a later mount reconstructs only persisted rows. A newly selected `File` is never attached to an existing identity by name and size. Recovering a remote `transferring` row means cancel, then select the file again as a new batch starting at zero (`docs/postmortems/2026-09-21-workspace-upload-remote-only.md`).

**Listing.** The mounted listing effect owns its request signal and polling timer. Metadata authority enables listing, including for stopped orbs; confirmed missing or deleting state, or unmount, cancels the in-flight read and stops polling. Older metadata cannot re-enable listing after deletion, and late completions cannot schedule another poll. Requests have a 30s bound and typed errors.

## Destination and notification

Each transfer owns `/workspace/uploads/<transfer UUID>/<original filename>`. The UUID directory keeps the original name and prevents collisions, including two simultaneous files with the same name. Rejected: `name-2.ext` suffixes (racy to allocate, harder to retry and clean up). Uploaded files follow workspace retention: Stop and compute replacement keep them; archive and delete remove them. Nothing is extracted, executed, converted or published.

**One message per selection.** Files transfer independently, but everything selected together is one immutable batch, and exactly one inbox message lists the batch's published paths and sizes:

```text
The user uploaded files:
- "/workspace/uploads/<UUID>/input.bin" (12345 bytes)
- "/workspace/uploads/<UUID>/notes.txt" (42 bytes)
```

A one-file batch says `The user uploaded a file to …`.
- Membership is registered atomically before any bytes move and cannot change afterwards.
- The notification waits until every member is stored or explicitly cancelled. A failed or paused member stays retryable and holds the message; cancelling it lets one final message list only the successful files. A fully cancelled batch sends nothing.
- File contents never enter the message; the agent reads files with its tools. The message starts an idle agent or steers a busy one like any inbox message. Rejected: a context-only notification (needs its own adapter scheduling and recovery).
- The batch UUID is the inbox message UUID (the browser uses the selection's first transfer UUID). Paths are ordered by transfer UUID, so the body is identical across concurrency, retries and recovery; inbox deduplication prevents a second message after a crash between per-file marker updates.

**No wake.** The notification enqueues with `wake: false` under the inbox transaction's orb row lock. If Stop wins, the message waits for explicit startup and neither enqueue nor upload recovery requests startup. Rejected: a running-state precheck before a wake-capable enqueue (Stop can race between them). A finalized file whose notification is not yet accepted stays `stored` with a visible notification-pending outcome. Upload notifications do not cancel a pending sleep (`docs/lifecycle.md`).

## Streaming and persistence

```text
Browser File.slice (≤ 4 MiB)
  → authenticated browser HTTP endpoint
  → control-plane streaming proxy
  → runtime HTTP stream
  → immutable chunk files on the workspace disk
  → bounded streaming assembly + SHA-256
  → atomic no-replace publication
  → durable message inbox
```

- File bytes never enter PostgreSQL, image blocks, base64, a WebSocket, a whole-file `arrayBuffer` or a whole-request body parser. Both HTTP servers install a raw streaming parser for `application/octet-stream`; Node fetch forwards with backpressure; the runtime awaits each disk write before reading more. The browser sends native Blob slices. Assembly and hashing read 64 KiB at a time.
- `UPLOAD_CHUNK_BYTES` (4 MiB, `packages/protocol/src/workspace-upload.ts`) stays under Cloud Run's HTTP/1 request limit and bounds buffering intermediaries; it is not a claim that platform layers never buffer.
- Per-transfer buffering is bounded; total memory scales with actual concurrent transfers. There is deliberately no global concurrency admission. Size and quota policy beyond safe-integer representation is question 59 in `docs/open-questions.md`.

**Metadata.** `workspace_uploads` (migrations `016_workspace_uploads.sql`, `017_upload_batches.sql`) is owned by the orb via `ON DELETE CASCADE` and holds transfer and batch identity, filename, declared size, incarnation, committed offset, status, destination, SHA-256, `active_until`, last error and timestamps. Bytes and filesystem commit markers live only on the workspace. Batch registration holds the orb row lock and inserts every member in one transaction; retries must match the full original identity/name/size set. No timing window, browser counter or opportunistic inbox coalescing defines a batch.

**Runtime staging** is `/workspace/.uploads/<UUID>/`. A manifest binds identity to filename and size. Each chunk streams into an exclusive temp file, is flushed, renamed to `<offset>.chunk`, and the directory is flushed **before** acknowledgement. Only contiguous committed chunks count toward the resumable offset. Leftover `.partial` files are ignored and removed by the next operation on that transfer. Retries query the committed offset instead of appending blindly.

**Publication.** Completion streams committed chunks into an exclusive assembly file, hashes and flushes it, then publishes with a hard link that cannot replace an existing destination, and flushes the destination directory and completion metadata. Replay verifies existing destination bytes instead of overwriting; status reconstructs completion after a crash between publication and its marker. Completed staging chunks are removed; cancellation leaves a tombstone so a delayed request cannot recreate the transfer. Directory creation flushes parent entries.

**Serialization and fencing.** A per-transfer queue serializes chunk/status/finish/cancel; independent uploads run in parallel. Runtime requests carry `x-orb-incarnation` and reject other incarnations. Control-plane metadata writes fence the current incarnation and destructive states; a completed notice may still be acknowledged after replacement because the file is retained workspace state.

## HTTP surface

Browser endpoints:

- `GET /api/v1/orbs/:orbId/uploads`: persisted outcomes, also for stopped orbs.
- `POST /api/v1/orbs/:orbId/uploads`: register one selection `{ id: batchId, files: [{ id, name, size }, …] }`. Running orbs only; immutable membership; JSON body limit 1 MiB. Returns transfer views including `batchId`.
- `GET /api/v1/orbs/:orbId/uploads/:id/status`: reconcile offset or completion with the runtime.
- `PUT /api/v1/orbs/:orbId/uploads/:id/chunk?offset=N`: raw bytes, known `Content-Length`, ≤ 4 MiB.
- `POST /api/v1/orbs/:orbId/uploads/:id/finish`: persist finalization intent, publish, and enqueue the batch notification once every member has a terminal file outcome.
- `DELETE /api/v1/orbs/:orbId/uploads/:id/cancel`: remove uncommitted bytes and persist cancellation.

The runtime mirrors these at `/v1/uploads/:id/:action`, with bounded metadata in the query and the incarnation header, on the private control-plane↔runtime boundary. The browser never reaches it directly. The runtime returns only bounded progress metadata, schema-checked at every adapter boundary.

**States:** `transferring → finalizing → stored → notified`, plus `cancelled` for unpublished transfers. `notified` means the inbox durably accepted the message, not that the agent processed it.
- Finalization intent is persisted **before** the runtime may publish.
- While running, reconciliation checks incomplete finalization and retries inbox acceptance without the browser.
- Recovery derives one action from existing row fields: notify, resume active finalization, discover publication only, or nothing. Only error-free intent with an unexpired lease may resume assembly, rechecked after runtime status returns. Failed or expired intent may still discover publication and notify. Compute replacement keeps error, lease and idle protection but grants no retry authority; explicit activity admission is the retry path.
- A failed finalization is visible and does not renew the lease on each reconcile pass, so a broken upload cannot pin compute forever.
- Backend recovery covers `finalizing` and `stored`, never an incomplete `transferring` row (only the browser holds those bytes).

## Idle protection

An admitted transfer is lifecycle activity: it prevents idle auto-stop for the whole transfer, including gaps between chunks, slow sources and sinks, and finalization, regardless of tab visibility or agent activity. It is not agent-busy: no busy event or streaming mark is fabricated.

- **Lease.** Each transfer owns a renewable activity lease of `UPLOAD_LEASE_MS` (5 minutes). Admission, chunks and status checks renew it. Browser↔runtime HTTP operations have a two-minute deadline; runtime assembly has a bounded read deadline.
- **Projection.** `orbs.upload_active_until` is the maximum active lease. Admission, renewal and terminal updates lock the orb row, update it and refresh `last_busy_at`.
- **Fence.** Admission from an unprotected or expired interval, and terminal release, also advance the orb's state version without changing lifecycle state or `state_changed_at`. Renewals inside an active interval do not, so they don't needlessly conflict with Stop. The idle-stop CAS checks the projection in its own update, and the version bump invalidates idle decisions made before admission or release. Unlike ordinary activity touches, upload activity deliberately advances this fence to close the admission vs idle-CAS race. No new lifecycle state.
- **Release.** Completion, cancellation, failure or expiry releases protection and refreshes the idle anchor; the anchor includes the projected lease expiry, so an abandoned transfer gets a fresh idle window when protection ends. An abandoned lease expires, so stale metadata cannot keep compute alive; its committed staging bytes remain until cancellation or workspace destruction. Expiry is not cancellation and does not prove bytes were never accepted.
- **Explicit Stop, archive and delete** ignore the idle-only guard and can interrupt transfers.
- Sleep waits for admitted uploads to drain (`docs/lifecycle.md`).

## Observability

- Durable: `workspace_uploads` rows (batch, member status, offset, error, incarnation, timestamps) and `orbs.upload_active_until` reconstruct the protection interval and why a notification is pending. Upload routes emit no per-chunk or per-reconcile events, and both Fastify servers disable application request logging.
- User-visible: unfinished outcomes and errors in the non-scrolling header stack; notification and inference outcomes in the inbox and transcript.
- **Diagnosing a stalled offset.** A stable committed offset alone is not a backend stall. Distinguish the last completed chunk request (Cloud Run request metadata), any later non-GET request, the persisted status/error, and whether the page shows a locally owned or remote row. Read-only runtime staging inspection can corroborate committed chunks. None of these sources can prove a browser navigation or component remount.

## Testing

- DST runs the production recovery/notification coordination and store semantics under scheduled admission, stop, replay, expiry, and incarnation/deletion races, with fake persistence that separates volatile writes from durable state. Invariants: no duplicate notification, no upload-driven wake, no idle-stop winning after admitted activity, explicit Stop keeps authority. Batch registration is one atomic simulation boundary with checkpoints and failpoints. The lease and wake-suppression store contract runs on the simulation store, PGlite and (when enabled) PostgreSQL. DST must also cover hidden or disconnected browsers, slow sinks and inter-chunk delays beyond the idle window, crash/expiry recovery, and Stop vs notification acceptance. Batch notification reads durable membership and outcomes, never a caller snapshot.
- Runtime filesystem tests establish the durability contract the fakes model: binary and short chunks, crash debris, lost acknowledgements, immutable metadata, zero-byte files, completion replay, no-replace publication, publication-before-marker recovery.
- A real TCP test streams through both HTTP servers into runtime storage, compares bytes, sees one inbox message, and checks stopped-orb and incarnation rejection.
- Chromium fixture E2E covers picker activation without a dialog, exact 4 MiB + tail chunk sizes (measured from server-acknowledged offsets, since routed requests hide browser-added `Content-Length`), held finalization, retirement, draft preservation, running-only visibility, inline failure with same-identity retry, overlapping selections, a two-file batch with one failed chunk producing exactly one message, and the drag-and-drop routes.
- Full-slice E2E selects a binary file and a text sidecar for a real agent; one notification must lead the model to `sha256sum` the binary and read the sidecar. Scripted model responses need an explicit inference barrier (`docs/postmortems/2026-09-09-upload-e2e-script-order.md`). Runtime changes keep the `npm run test:e2e` gate.
- Live Cloud Run large-file transfer and per-transfer memory bounds cannot be shown locally (`TODO.md`).

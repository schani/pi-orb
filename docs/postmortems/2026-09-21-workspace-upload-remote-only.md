# Workspace upload stopped and later rendered as remote

## Status

Production investigation only; no fix or deployment was authorized. The browser-side cause is not proved. Navigation or a component remount is the strongest hypothesis because the later UI represented the transfer as remote, but the available server logs do not record browser navigation or component ownership.

## User-visible failure

Orb `46034f79-31c6-46df-b212-729d0f78633a` showed `signals-orgs-2026-09-21T19-49-30.872Z.jsonl` stopped at `25,165,824 / 61,030,774 B`. The later screenshot offered **cancel**, not **pause** or **retry**. Transfer ID `5b4a3250-4650-4445-a5a9-3e9dab5e4b7a` remained visible through persisted upload polling.

A transcript receipt elsewhere showed an uploaded file of 11,827,760 bytes. Notification text uses the successfully published transfer's declared size, so that receipt is not this 61,030,774-byte transfer. The available screenshots do not identify whether an earlier 4 MiB progress display belonged to either transfer.

## Confirmed request timeline

Cloud Run request logs recorded six chunk PUTs, all HTTP 200, at offsets `0`, `4194304`, `8388608`, `12582912`, `16777216`, and `20971520`. Each took 0.24–0.72 seconds. The sixth request was logged at `2026-09-21T19:52:43.726404Z`, advancing the durable offset to exactly `25,165,824` bytes (`6 × 4 MiB`). These requests provide no evidence of a proxy, control-plane, runtime, or filesystem failure through chunk six.

Upload-list GET polls remained HTTP 200 through `19:52:44.979Z`. No request for this orb appeared in the remainder of the inspected window through `19:53:10Z`. Upload-list polling was present again in the inspected logs at 19:56 and later. No later chunk PUT, finish request, or non-GET upload request appeared in the inspected logs. Cloud Run request logs do not establish why the browser stopped issuing upload work.

## UI and recovery semantics

`useWorkspaceUploads` keeps the selected `File` and request controller only in mounted component memory:

- an active local transfer renders **pause**;
- an inactive local transfer that still owns its `File` renders **retry** and **cancel** after admission;
- a persisted row returned by polling with no matching local transfer renders **cancel** only.

The screenshot therefore establishes that the rendering page no longer had matching local transfer ownership. It does not establish how ownership was lost. Unmount cleanup aborts owned requests; reload or later remount reconstructs only persisted rows. The backend deliberately does not resume an incomplete `transferring` row because it has no authoritative local bytes. Running reconciliation handles `finalizing` and `stored`, not incomplete `transferring` rows. Lease expiry ends idle protection but neither cancels the transfer nor removes its staged bytes.

The supported recovery for a remote incomplete row is **cancel, then select the file again**. Cancel tombstones the old runtime transfer and removes its staged chunks. A new picker selection always creates a new batch and transfer UUID and starts at zero; matching name and size never attach new browser bytes to the old identity. Same-mounted-page retry is the only UI path that retains the original `File`, queries the committed offset, and continues the old identity.

## Diagnostic boundary

The durable offset means only that contiguous chunks through that byte were acknowledged after runtime file and directory flushes and then recorded by the control plane. A stable offset alone must not be called a backend stall: distinguish the last completed PUT, any later non-GET request, current local-versus-remote UI ownership, and the persisted row's status/error.

The browser and runtime Fastify servers disable application request logging, and upload routes emit no per-chunk application events. Available production evidence is Cloud Run request metadata, the `workspace_uploads` row, the orb's upload lease/incarnation fields, and read-only runtime staging inspection. The exact request-log query is:

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND resource.labels.service_name="pi-orb"
 AND httpRequest.requestUrl:"/api/v1/orbs/46034f79-31c6-46df-b212-729d0f78633a/uploads"
 AND timestamp>="2026-09-21T19:45:00Z"
 AND timestamp<="2026-09-21T20:05:00Z"' \
--project=playground-dev-6ae7 --order=asc --limit=500 --format=json
```

The corresponding durable-state query is:

```sql
SELECT id, batch_id, name, size, incarnation, status, offset_bytes,
       path, sha256, error, active_until, created_at, updated_at
FROM workspace_uploads
WHERE orb_id = '46034f79-31c6-46df-b212-729d0f78633a'
ORDER BY created_at, id;
```


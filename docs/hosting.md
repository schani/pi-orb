# System-hosted files

System-owned static files published by an orb under a durable, orb-specific namespace.

## Requirement and status

**Implemented 2026-09-07.** An orb can upload a file and
receive a stable URL without running a web server. Files survive compute replacement, stop/start,
and archival. Each immutable orb ID owns one namespace; an orb name or project name never enters
the storage identity. Access, deletion behavior, and rendering isolation are decided below. Folder
publication, limits, and version history remain open in `docs/open-questions.md`.

## Agent interface

The runtime image provides a small hostr-like wrapper:

```text
pi-orb host file.html design/index.html
pi-orb host ls
pi-orb host rm design/index.html
```

The first command publishes raw file bytes at a normalized relative path and prints the canonical
URL. A request for `/design` redirects to `/design/`, which serves `design/index.html` so relative
assets resolve under that directory; no generated directory listing is served. Re-publishing a
path replaces what future reads return. The runtime-facing request derives
the orb exclusively from its existing per-incarnation bearer: the body and path cannot select a
sibling namespace.

The wire surface is a bounded raw-byte `POST` to self-scoped
`/runtime/v1/hosting/files?path=...`; `GET` lists and `DELETE` removes. The CLI owns file reading,
MIME hints, a five-minute transfer deadline,
typed errors, and lost-response wording. Protocol schemas own path and response validation.

**Streaming requirement (decided 2026-09-07).** Uploads and downloads stream end to end. Upload is
CLI file stream → runtime route stream → the GCS resumable-upload REST adapter; download is GCS
media stream → browser route →
HTTP response. Each leg honors backpressure and cancellation while counting bytes and hashing
incrementally. GCS writes use bounded 256 KiB chunks; a whole-request retry reopens the source stream.
Hosting transfer paths may not use `readFile`, full-body parsers, `arrayBuffer`, `blob`, base64, one
full-content `Buffer`, or a temporary file as a substitute for bounded memory. Fakes represent
chunks or generate bytes instead of holding whole-file fixtures and claiming the memory bound from
them. Browser downloads use normal navigation or download links rather than `fetch` followed by a
whole-file `Blob`.

Uploads are currently limited to 32 MiB, matching Cloud Run's documented HTTP/1 request limit.
Neither bounded streaming memory nor GCS requires this cap. The current upload API sends one HTTP
request per file, and the server uses HTTP/1. Larger
uploads require end-to-end HTTP/2 or a multi-request upload API; an HTTP/2 client alone does not
change the server's limit. Transfers also have a five-minute application deadline. GCS itself allows
[objects up to 5 TiB](https://docs.cloud.google.com/storage/quotas).
Before cloud release, live validation must observe first response bytes before source EOF, reverse backpressure, cancellation,
and bounded process memory as file size increases. It cannot promise that unmanaged IAP/proxy
internals or browser DOM consumers never buffer. Cloud Run documents a 32 MiB limit for HTTP/1
requests even when streamed ([quotas](https://docs.cloud.google.com/run/quotas)); the deployed
upload transport and the exact boundary must be verified before cloud release because the
application cap leaves no documented transport headroom.

## Storage and publication

Production bytes live in a dedicated private GCS bucket, separate from OpenTofu state. PostgreSQL
is authoritative for published names and lifecycle ownership. A catalog row contains orb ID,
normalized path, immutable object reference, byte size, media type, content hash, created time,
and updated time. `(orb_id, path)` is unique. Local development uses a filesystem adapter; DST uses
an in-memory fake.

Hosted storage is a control-plane capability, independent of `OrbHostProvider`. Every orb uploads
through the same control-plane API and existing runtime bearer; it receives no GCS credential, and
Docker, process, GCE, or future compute providers gain no hosting methods. The current GCP control
plane can therefore store bytes in GCS for an orb running on any provider, including local Docker
or process compute. Cloud download IAP is the control-plane deployment's authentication boundary,
not a property of the orb's host provider.

A local control plane stores bytes under a separate durable filesystem root configured independently
from the orb host provider; the PostgreSQL/PGlite catalog and domain protocol remain unchanged. Its
files use a separate loopback hostname under the same trusted local access boundary as the existing
application, without claiming cloud IAP locally. A fully non-GCP remote control plane would need a
durable shared object store when multiple control-plane instances serve it: an upload handled by one
server must be readable by another. This refers to control-plane servers, not the number of orbs;
one control plane with many orbs needs only its own durable filesystem. GCS already supplies shared
storage for the cloud deployment. A future S3 adapter can implement the
same byte-store port, but is outside the current implementation unless requested.

GCS and PostgreSQL cannot share a transaction, so publication never overwrites an object in place.
GCS makes an individual object write atomic, but the catalog boundary still needs an explicit
protocol ([Cloud Storage consistency](https://docs.cloud.google.com/storage/docs/consistency)):

1. transactionally fence the caller's current incarnation and lifecycle state and record an upload
   operation that owns a new immutable object reference;
2. stream and hash bytes into that operation's object;
3. in one transaction, recheck the fence, insert or swap the catalog pointer, mark the upload
   published, and record the superseded object for cleanup.

Before step 3, the old path remains current. After step 3, the new object remains current even if
cleanup fails. Durable upload/cleanup ownership lets reconciliation distinguish an abandoned new
object from a published one after any crash. Garbage collection atomically claims an abandoned
operation before deleting its object, so it cannot race an active publisher.

Removal transactionally unpublishes the path and moves its exact object reference into a durable
cleanup intent. It deletes the object afterward and retires the intent only after confirmed
absence. This prevents a broken catalog pointer and fences removal from a concurrent replacement.
Expected failures use typed `Result`/`ResultAsync` values at the immediate adapter boundary.

**Decided 2026-09-07:** the CLI supplies a UUID request ID bound to the orb, incarnation,
normalized path, media type, byte size, and SHA-256. Exact replay returns the original published
acknowledgement without changing a later publication; different parameters conflict, and a new ID
means a new publication. Source bytes are not pulled until the resumable session URI is durably
registered. A lost begin response therefore leaves an empty inaccessible session that cannot
complete. Known data-capable sessions must reach confirmed cancellation or verified completion
before exact-generation deletion and orb finalization; lease expiry is never terminal proof. Cloud
Storage documents that deleting a resumable upload session prevents future use of that session
([resumable uploads](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads)). If
completion wins cancellation, cleanup adopts and deletes the returned exact generation. Session
URIs are bearer secrets and are never logged.

The filesystem adapter retains content-free cancelled and committed session markers after cleanup.
They preserve terminal answers for delayed stale callers and contain no hosted bytes. Permanent
deletion removes every object `data` file; tests distinguish that byte namespace from these markers.

## Serving and access

**Decided 2026-09-07:** use the existing control-plane application and roles, with no new service.
The runtime role accepts uploads through the existing per-incarnation bearer. The browser role
serves `GET` and `HEAD` behind exactly the same IAP access policy as pi-orb; downloads are never
public. The GCS bucket remains private, and no public bucket permission or signed download URL
bypasses IAP. Private responses use `Cache-Control: private, no-cache` plus the content hash as
their `ETag`. There is no public-sharing or CDN contract.

A separate serving service would allow independent scaling and failure isolation with narrower
IAM, but the intended load does not justify another process. It would not by itself create browser
origin isolation: hostname choice, not service topology, determines the same-origin boundary.

The route resolves orb ID plus path in PostgreSQL and snapshots that exact object generation before
streaming it. Reads carry no lease. Concurrent permanent deletion may explicitly interrupt a read;
the response counts and hashes chunks and never reports a clean successful EOF for truncated or
mixed bytes. Missing paths
preserve the requested URL and return a file-specific `404` with a dashboard link. Rendering
origin is a separate hostname mapped to this same monolith, using the same IAP policy and a host
route allowlist containing no browser API routes. This contains uploaded code by origin without
adding a process; normal cross-origin mutation protection still applies. Rejected: the browser
origin with a response CSP sandbox excluding `allow-same-origin`; its opaque origin can break
scripts, modules, and external fetches, and sandboxing alone does not replace CSRF/origin
hardening. See the
[same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

The cloud configuration assigns the browser service a `files` traffic tag targeting its latest
revision. Files use `https://files---pi-orb-<project-number>.<region>.run.app`; the untagged
deterministic origin supplies dashboard links. Both addresses are known before deployment, avoiding
a self-reference in the service's environment configuration. Cloud Run documents
[tagged deterministic URLs](https://docs.cloud.google.com/run/docs/triggering/https-request#deterministic-url)
and [IAP protection across ingress paths](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run).
The [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat) includes `*.run.app`,
so these hosts cannot share a parent-domain cookie. Application API and WebSocket origin checks
still reject requests from hosted scripts.

## Lifecycle and product behavior

Upload, replacement, and removal require a currently authorized orb incarnation and are fenced in
the same database transaction that publishes the catalog change. Entering `archiving` admits no
new publication. Archive cleanup never removes published files: it retains the orb row, catalog,
and objects after clearing runtime authority. The orb page lists hosted paths, URLs, sizes, and
update times in both working and archived states. Content hashes remain internal integrity data.

**Decided 2026-09-07:** permanent orb deletion removes all hosted files. Cleanup must
enumerate durable catalog/operation ownership, delete every object idempotently, and only then
allow the orb row to disappear; a cascading foreign key must not erase the cleanup inventory.
Project deletion inherits this through child-orb deletion. Cleanup includes abandoned operations
and published and retired objects. The infrastructure disables soft delete,
object versioning, and retention on the dedicated bucket so successful cleanup means the live
hosted bytes are gone; any future provider retention must be an explicit product-policy change.

Successful reads produce no per-request log. Publication, replacement, removal, reconciliation,
and blocked cleanup produce sanitized durable outcomes sufficient to reconstruct which path and
object won, without storing contents or bearer values. Implementation needs store contracts,
adapter tests, deterministic crash checkpoints and failpoints around each object/catalog boundary,
and end-to-end coverage for restart, archive retention, exact replacement, and deletion cleanup.
The first implementation publishes one file at a time; question 51 keeps atomic folder releases
open rather than making them implicit in this contract.

## Verification

The implementation follows this plan and its focused unit, adapter, DST, HTTP, and frontend tests
run in CI. The opt-in real GCS adapter contract runs only when
`PI_ORB_TEST_HOSTING_BUCKET` names an isolated test bucket. Without that variable it is skipped and
performs no cloud mutation. The remaining live deployment gate follows `docs/testing.md`: the real
domain orchestration runs under `determined`; PostgreSQL/PGlite, HTTP, streams, GCS, and the browser
retain their own boundary tests.

### Test structure

- `apps/control-plane/src/domain/hosting.ts` owns reservation, publication, retirement, cleanup,
  and lifecycle fencing over `domain/hosting-ports.ts`.
- `apps/control-plane/src/domain/hosting.dst.test.ts` runs that production domain code with
  `runDst` and one `SimulationTask` per uploader, reader, cleanup worker, archive, or deleter.
- `apps/control-plane/src/testkit/hosting.ts` supplies one shared durable fake catalog and one shared
  deterministic byte-store model. Restarted workers receive new dependencies over those same
  instances; replacing the provider model would falsely erase accepted remote work. An invariant
  observer compares provider facts with durable catalog, attempt, and cleanup ownership at effect
  boundaries.
- `apps/control-plane/src/testkit/failpoints.ts` gives hosting one named vocabulary. The store
  contract in `adapters/pg/hosting.contract.ts` runs against the fake, PGlite, and PostgreSQL for
  atomic fences, claims, pointer swaps, and cleanup-inventory operations.
- Filesystem contracts use generated sources; GCS tests inject its HTTP transport, with an opt-in
  real-bucket contract. Process and Docker E2E select storage independently from compute; they do not
  require unimplemented exe.dev or AWS host providers.
- Existing `orb-archival.dst.test.ts`, `orb-deletion.dst.test.ts`, and
  `project-deletion.dst.test.ts` compose hosting work with the real lifecycle reconciler. They fully
  drain accepted late operations before asserting provider and database absence.

The byte-store model generates deterministic chunks and records size/hash rather than holding one
file value. It distinguishes request/session acceptance, chunk receipt, provider commit, response
delivery, cancellation, exact object generation, read open, and read chunks. Provider commit may
survive caller death or a lost response. Explicit checkpoints and failpoints bracket reservation,
each chunk pull/write, provider finalize, publish commit before/after ambiguity, retirement claim,
exact-generation delete, cleanup finalization, response delivery, read open, and read chunks.
Workers stay schedulable until their modeled completion predicate; fixed checkpoint counts are not
used across native promises. Operation/object IDs and wall/monotonic clocks come from injected
deterministic dependencies; the domain, fakes, and scenarios use no real randomness or sleeps.

### Invariants

- Every published catalog pointer names one complete immutable object whose recorded byte count,
  media type, and hash match; an object generation is never reused or mutated.
- Concurrent replacement linearizes to one catalog value. A successful download emits one complete
  exact generation. Injected failure may produce an explicit typed failure/interrupted response,
  never mixed generations, silent clean truncation, or bytes from another orb/path.
- Every object and data-capable upload session has one durable owner: active operation,
  published catalog entry, retirement/cleanup intent, or terminal deletion inventory. Finalized
  deletion leaves no bytes or session capable of accepting bytes. An inaccessible empty session
  from a lost begin response can expire at the provider; no file bytes were sent to it.
- An operation that loses a response is safely replayed or reported unknown according to question
  53. Commit ambiguity never creates a second publication or retires the winning object.
- Archive admits no new publication and retains every publication committed before its fence.
  Permanent orb/project deletion and archive-to-delete upgrade eventually remove catalog entries,
  operations, sessions, and all object generations, including completion after caller death.
- Cleanup claims are exclusive across workers and restart. Expiry alone never authorizes assuming an
  external upload cannot finish; the byte-store contract supplies provider-confirmed terminal proof.
- Healthy reads create no log. Publish/delete outcomes and cleanup blockers are durable,
  edge-deduplicated, sanitized, and sufficient for the UI to explain blocked cleanup.

### Focused schedules

Each race gets a forced schedule that reaches its critical window and an entropy run with relevant
failpoints. Recovery/liveness assertions run in a final fair phase with injected faults disabled;
safety assertions apply after every boundary, including failing schedules.

1. Two uploads replace one path while readers open before, during, and after publication; a control
   case publishes unrelated paths and namespaces concurrently.
2. Every reservation/upload/finalize/publish response is lost in turn, then replayed across a
   control-plane restart. Before- and after-commit failures establish exact read-back behavior.
3. Stop, incarnation replacement, archive, delete, and archive-to-delete land between reservation,
   chunks, provider completion, and publish commit. No stale caller publishes, and no new publish
   reservation is admitted after the lifecycle fence.
4. Orb and project deletion race accepted uploads and late provider completion. Two cleanup workers,
   worker death, claim expiry, cancellation, and exact-generation deletion converge without losing
   inventory or deleting a newer replacement.
5. Explicit removal races replacement so it unpublishes only the exact observed generation.
   Cleanup races active and paused writers, including a writer that begins or completes provider
   work after cleanup claims it; tests pin the provider-confirmed terminal proof.
6. A reader races replacement retirement and permanent deletion at read-open and every chunk. Tests
   pin the implemented exact-generation read contract rather than assuming an open GCS read survives deletion.
7. Stop/start, compute replacement, and archive retain the exact catalog and bytes; archive blocks
   later writes while the retained file remains downloadable.
8. Zero-byte, tiny, large generated, and concurrent transfers cover chunk boundaries, source/sink
   errors, deadlines, reverse backpressure, cancellation, and bounded read-ahead.
9. Repeated healthy reconciliation emits nothing; one changing blocker/outcome emits one durable
   edge and appears in the hosted-files UI state.

DST proves coordination and bounded chunk accounting only when production coordination consumes an
injected source/sink. It does not justify refactoring adapter-owned Node streams merely to simulate
them. Real stream adapter tests use slow pullers/sinks, aborts, and measured buffered bytes against
the production pipeline; actual GCS adapter tests use a deterministic HTTP transport, plus an
opt-in small real-bucket contract for resumable-session and exact-generation semantics. The pending
cloud-release validation in `TODO.md` must verify the separate-host route allowlist through IAP,
first bytes before source EOF, reverse backpressure/cancellation, and bounded process memory as size
increases. DST does not claim those platform properties.

Conventional protocol/route/browser tests cover missing or invalid runtime identity and host/origin
denial for `GET`, `HEAD`, and conditional `GET`; the files hostname cannot serve API
routes and the default hostname cannot bypass the files-host policy. A browser security test proves
uploaded JavaScript cannot read the app API or cause authenticated mutations. Route/browser tests
also cover relative assets, directory/index redirects, MIME and cache/security headers, traversal
rejection, and the resource-specific `404` with dashboard link. Authorized and unauthorized IAP
principal checks remain part of the pending cloud-release validation. Quota and multi-file cases are
added only after questions 50 and 51 select those contracts.

Every `runDst` failure records a trace under `test-failures/`, immediately proves replay, and is
debugged first with `DST_REPLAY=<trace> npx vitest run apps/control-plane/src/domain/hosting.dst.test.ts -t '<failing test>'`;
a passing rerun never clears the failure.

As a sanity check on the tests themselves, programmed mutations remove the publish lifecycle fence,
allow cleanup without an exclusive claim, make reads follow a second catalog lookup mid-stream,
and eagerly drain a source. Each mutation must fail its corresponding focused test before the suite
is accepted.

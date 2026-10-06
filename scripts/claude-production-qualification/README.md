# Synthetic Claude native acceptance

No owner credentials, provider authorization, cloud resources or upstream model
requests. Linux x86-64, Node 24, `sudo`, `unshare`, `setpriv`, `ip`, Git and OpenSSL
are required. Lack of namespace privileges fails closed; it is not a skipped gate.

```sh
npm ci
node --test scripts/claude-production-qualification/receipt-edge.test.mjs
node_modules/.bin/vitest run packages/native-image/src/claude-workload.test.ts
bash infra/native-vm/claude-acceptance.sh "$PWD"
```

`infra/native-vm/acceptance.sh` preserves the existing Pi guest/runtime checks,
then runs this workload with retained files under `/workspace`. The helper and
its dependencies are included by the existing native-image source snapshot.
Installation copies only these four helpers to `/opt/pi-orb/claude-qualification`,
which survives removal of `/app/infra` during sealing. The relocated-tree test
executes against runtime inputs with no `infra` directory. Image installation
explicitly installs the namespace/TLS tools. The workload
imports the image's production `ClaudeOrbAgent`, SDK and native executable—not
an independently installed SDK.

## Boundary

A root wrapper creates fresh network, PID and mount/proc namespaces, enables only
loopback, then drops to UID/GID 2000 with no supplementary groups/capabilities,
`no_new_privs` and an empty environment. Its HTTPS broker, MCP server, fake
Messages server, runtime processes, native tools and temporary certificate all
live inside that namespace. No host route, metadata access or host loopback
service is available. Namespace teardown kills all descendants. The namespace deadline is 105s plus 5s kill grace; privileged EXIT cleanup has
its own 5s plus 1s kill grace. A 120s caller budget leaves four seconds for trace
export. Cleanup removes only the newly allocated scratch tree, preserves a failed
workload's exit, and turns otherwise successful execution into failure if removal
fails. No timeout increase is needed.

The synthetic broker supplies a non-credential subscription bearer. The test
factory calls the genuine pinned SDK, retaining production options except for
routing/traffic suppression and a supervised subprocess observer. Native
`accountInfo()` is **not** stubbed: production subscription-source verification
must pass; the model fixture rejects API-key headers. The temporary TLS CA is
passed only to test-owned workers. No TLS-verification bypass is used.

The fake server scripts native Bash and a configured native HTTP MCP tool,
verifies their results in the next model request, and holds one later request to
exercise a real in-flight SIGKILL. Repository setup/resume hooks write fixed
sentinels. Three changed compute incarnations run setup/resume three times.

## Assertions

- Real adapter boot reaches ready/idle after native subprocess/stream drain,
  without inference.
- Native Bash and configured MCP execute once; terminal history and UUID-correlated
  inbox receipts are pull-readable.
- Idle/prepared state requires native exit, actual stdout EOF, natural public
  iterator completion, tracked hooks and final durable history before SDK/MCP
  cleanup. Completing the input `AsyncIterable` lets the pinned SDK writer end
  stdin gracefully; SDK `close()` queue completion alone is not EOF proof.
- A normal runtime restart preserves session identity and immutable native/product
  history, without automatic inference.
- Before the in-flight crash, the exact journal UUID is observed in a complete
  native JSONL line and scanned into a durable inbox receipt. Model-request
  arrival alone is not this checkpoint.
- After SIGKILL, native resume retains that receipt, emits a durable manual
  continuation notice, and makes no inference until a new message is delivered.
- Retried completed/interrupted inbox IDs remain duplicate/persisted; the original
  Bash side effect is not repeated. Manual continuation sees retained native tool
  and conversation context.
- Injected `fail-in-flight` exercises owned process and filesystem cleanup.

Successful output contains outcome booleans. Failure output also contains the
last atomic, fsynced checkpoint: monotonic phase/counters, allowlisted health
codes, separate exit/stdout-EOF/public-iterator/hook edges, and safe
native/normalized/stream type and UUID/parentUUID/session identity metadata.
Non-UUID IDs use bounded aliases. The existing receipt helper filters native
source rows; worker observations use public agent snapshots/health and owned
SDK/process/hook boundaries, not private-agent reflection. No additional sealed
helper is installed.

Limits are 128 rows/category, 64 pending block indices, 512 aliases, 256 edges,
a 256KiB native-file tail and a 192KiB checkpoint. Typed read/write/overflow
failures preserve the preceding checkpoint when replacement has not occurred.
Raw journals, payloads, error text, native stderr, headers, paths, URLs, codes,
tokens and environment values are never exported. `billingQualified` and
`organizationPolicyQualified` are always false.

Failure traces reach structured stdout before scratch cleanup, including after
namespace SIGKILL. Capture stdout/stderr with at least 512KiB buffers. Optional
argument four is an existing, caller-owned output directory; failure export
creates a fresh mode-0600 file without overwriting a caller file:

```sh
bash infra/native-vm/claude-acceptance.sh "$PWD" /owned/scratch-parent accept /owned/traces
# /owned/traces/.pi-orb-claude-trace.<unique>
```

**Qualification limit (2026-10-05):** current scoped native contracts pass, but
two earlier synthetic fixture timeouts have lost schedules/scratch. Controlled
inode-watch and late-health timeout classes were reproduced and fixed without
uniquely attributing those occurrences. The user explicitly exempted only these two older occurrences on 2026-10-05;
safe future trace retention is not retroactive proof. Separate explicit user
acceptance clears the WebKit blocker for pinned Ubuntu after three passes,
not the unknown Debian crash cause. Chromium's full-browser fixture repair passes four native controls and two
complete both-engine target runs; current scoped browser blockers are cleared
without claiming browser internals fixed (`docs/testing.md`). Frozen full configured E2E, control-plane image build and source-closure gates
passed; supplemental real PostgreSQL contracts and the subsequent test/docs-only
delta are recorded in `docs/testing.md`. No deployment or cloud canary is
performed or authorized. Native attribution limits remain in
`.context/claude-production-hardening/native/forensics/handoff.md`.

## Local Docker invocation (not executed)

The runtime image does not carry these validator files; mount them read-only.
The workspace mount is test-owned. Namespace creation requires these additional
privileges; they do not authorize outbound access (`--network none` is also set).

```sh
docker run --rm --network none --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --user 0 \
  --mount type=bind,src="$PWD/infra/native-vm",dst=/qualification,readonly \
  --tmpfs /workspace:rw,size=128m \
  --entrypoint bash CANDIDATE_RUNTIME_IMAGE \
  /qualification/claude-acceptance.sh /app /workspace
```

The candidate must contain `iproute2`, `util-linux` and OpenSSL. No Docker
build/run or native cloud image creation is part of the local checks above.

## Cloud qualification remains approval-gated

An authorized disposable image build can use the existing native-image builder,
source archive/inventory hashes and isolated validation accounts. Standard
acceptance now runs both harnesses. Preserve the image/workspace IDs, host-key
fingerprint, safe guest result, cleanup ledger and original failures. Do not run
`infra/release.sh`, change production images or apply production IaC as a way of
creating a sandbox.

This workload proves retained files across runtime process loss on the supplied
filesystem; it is **not** a physical VM reboot, disk reattachment, Cloud Run/IAP
role, real Secret Manager IAM or migration-job qualification. Those require
separate disposable infrastructure and authorization. IAM qualification should
use a dedicated synthetic secret: shared control-plane identity can add/read/
destroy versions; orb and issuer identities cannot. Browser/runtime services
share that identity today; route-role restrictions are application boundaries,
not separate IAM identities. Never read the owner's secret for an IAM test.

Real provider accounting requires separate explicit owner permission for a
bounded inference and owner-observed subscription usage, not the synthetic
bearer's `accountInfo()` metadata. Saved subscription tokens are model-only by
the provider contract; a fake backend cannot validate their scope, yearly expiry,
subscription ledger or organization effort enforcement.

# exe.dev as an orb host provider — evaluation (2026-08-05)

Status: **feasible with caveats — proposal, not decided.** Summary lives in
`DESIGN.md` §5.3; the decision is tracked as open question 35. This document is
the full writeup.

## What exe.dev is

exe.dev (https://exe.dev) is a subscription service providing Linux microVMs
(Cloud Hypervisor, though they call that an implementation detail) that boot
**directly from an OCI container image** in about two seconds. The persistent
disk *is* the VM's root filesystem, instantiated from the image at create time.
Each VM gets SSH access (`ssh <vm>.exe.xyz`) and an HTTPS proxy
(`https://<vm>.exe.xyz`, with ports 3000–9999 forwarded), gated by exe.dev
authentication — including per-VM bearer tokens that can be minted offline by
signing with the account's SSH key.

Pricing is a flat subscription over a **shared resource pool** (~$20/month
personal tier: 25 VMs sharing 2 CPUs / 8 GB RAM / 25 GB disk as of this
evaluation; team pools and a fully usage-based "Cloud Pool" plan exist).
VMs are not billed individually — an idle VM costs roughly nothing beyond its
disk usage. One region per account (US, EU, APAC options).

The API is unusual but simple: the SSH CLI verbatim, also reachable as
`POST https://exe.dev/exec` with the command as the POST body (bearer-token
auth, `--json` output, 30-second timeout, 64 KB body limit, per-key rate
limits). There are no async operations to poll — `new` completes in ~2 s.

## How it maps onto `OrbHostProvider`

Checked against the port in `apps/control-plane/src/domain/ports.ts` and the
contract in `DESIGN.md` §5.

| Port requirement | exe.dev mapping | Fit |
|---|---|---|
| `provision` idempotent by orbId | `new --name=pi-orb-<orbId> --image=<runtime image> --env KEY=VALUE --tag pi-orb` | Good — pending duplicate-name behavior verification |
| Runtime delivery (OCI image + 4 env vars) | Image boots as-is; `--env` at create | Excellent — the entire GCE startup script disappears |
| `observe` with definitive absence | `ls --json`; VM absent from `ls` is definitive | Good — field shape (state/health) unverified |
| `listManagedHosts` with orb association | Name prefix + `--tag`; dedicated account gives hard tenancy isolation | Good |
| `stop` (retain filesystem) | **No stop primitive** — CLI has only `new`/`rm`/`restart` | Gap — see mismatch 1 |
| `start` (restart in place) | `restart` (rootfs persists, entrypoint reruns) | Good |
| Token readback on provision-reuse | No metadata store; read back over SSH exec | Workable, hackier than GCE instance metadata |
| `diagnose` (optional) | SSH exec — read logs directly | Better than GCE guest attributes |
| Control plane → runtime HTTP/WS | Through exe.dev's authenticated proxy | Works with contract extension — see mismatch 3 |
| Runtime → control plane broker | Outbound HTTPS, URL + orb-token bearer | Already provider-agnostic by design |

## The three real impedance mismatches

### 1. No stop/start lifecycle

VMs are always-on; the pricing model makes idle nearly free, which is exactly
why the primitive doesn't exist. Our lifecycle uses `stop` in four places:
idle auto-stop, the unreachable-runtime restart (`stop` + `start`), the orphan
sweep, and the `stopping` drain.

Options:

- **Emulate**: halt the runtime process over SSH and record "stopped" in a VM
  tag so `observe` stays truthful — a virtual lifecycle layered on tags + exec.
- **Accept always-on**: report `stop` as a no-op and disable idle auto-stop
  for this provider. The cost motivation for idle-stop largely vanishes here.

Whether an in-VM halt (`poweroff`) sticks, or the platform revives the VM, is
undocumented and must be tested.

### 2. No durable-data / disposable-boot split

On GCE the data disk (`/workspace`) survives while the boot disk is disposable;
runtime-image upgrades reach existing orbs via the script-freshness repair
(stop, rewrite metadata, recreate boot disk, start). On exe.dev the rootfs *is*
the persistent disk — re-imaging means `rm`, which destroys `/workspace`.

Consequence: existing orbs would be pinned to their creation-time runtime image
unless upgraded in place over SSH. Tolerable under the POC stance (broken orbs
are stopped and restarted — but restart does not refresh the image here), and
the weakest point of the whole mapping.

### 3. Network path inversion

Today the control plane reaches the runtime over plain HTTP to a private VPC
IP on port 8080, with no auth on that hop (security is network placement).
On exe.dev it would instead traverse exe.dev's authenticated HTTPS proxy:
`https://pi-orb-<orbId>.exe.xyz:8080` (8080 falls in the forwarded 3000–9999
range) plus an `X-Exedev-Authorization: Bearer <token>` header, where the
VM-scoped token is minted offline by signing with the account SSH key
(namespace `v0@<vm>.exe.xyz`).

Required changes:

- `runtimeAddress` grows provider-supplied headers (baseUrl alone no longer
  suffices); the runtime HTTP client and the live proxy attach them.
- The live proxy's `ws(s)://` derivation already handles an `https://` base;
  WebSocket forwarding **through exe.dev's proxy** is undocumented and must be
  verified empirically (their own Shelley web UI suggests it works).
- The runtime broker Cloud Run service flips from `ingress=internal` to public
  ingress so exe.dev VMs (outside our VPC) can reach it. Acceptable: the
  orb-token bearer is the real gate, and the broker hop was explicitly designed
  provider-agnostic (URL + bearer, no Google identity tokens).

## Customization: sufficient

- Custom Docker images, including private registries (`new --image
  --registry-auth USERNAME:PASSWORD`).
- `--env` (repeatable), `--setup-script` (≤10 KiB, first boot only — we likely
  need none at all), `--cpu` / `--memory` / `--disk`, and post-create `resize`.
- No kernel choice — irrelevant for us.
- Registry wrinkle: Artifact Registry wants short-lived OAuth tokens or a
  long-lived `_json_key` service-account credential; handing exe.dev a
  long-lived key is unattractive, so mirroring the runtime image to a
  PAT-authenticated registry (e.g. GHCR private) may be simpler.

## API suitability: good

The adapter would be a thin command-builder over one HTTPS endpoint —
honestly simpler than the GCE transport with its zonal-operation wait loops.
Notes:

- Per-key rate limits: amortize per-orb `observe` polling into one periodic
  `ls --json` for all orbs (we need `listManagedHosts` anyway).
- 30 s `/exec` timeout is a non-issue (`new` ≈ 2 s, no long operations).
- Tokens: account-level API tokens and VM-scoped proxy tokens are both
  locally mintable by SSH-key signing — no interactive auth, easy rotation by
  dedicating an SSH key to the control plane and revoking it to revoke all
  derived tokens.

## Open verification items (blocking the decision)

Tracked in DESIGN.md open question 35:

1. WebSocket forwarding through the exe.dev HTTPS proxy (the live proxy
   depends on it).
2. `ls --json` field shape — does it expose a state/health signal?
3. Duplicate-`--name` create behavior (our provision idempotency key).
4. In-VM halt semantics — does a `poweroff` stick?
5. Actual `/exec` rate limits under reconciler-shaped load.
6. Private-registry auth story against our image pipeline.

## Suggested next step

A $20 account and a half-day spike: boot the runtime image with `new`, hit
port 8080 through the proxy with an HTTP and a WS client using a locally
minted VM token, halt the VM from inside and watch what `ls` reports, then
`restart` and confirm `/workspace` survived. That answers every unknown above
before writing a line of adapter code.

## Sources

- https://exe.dev/docs/what-is-exe
- https://exe.dev/docs/faq/how-exedev-works
- https://exe.dev/docs/https-api
- https://exe.dev/docs/https-api-local-key
- https://exe.dev/docs/https-tokens-for-vms
- https://exe.dev/docs/customization
- https://exe.dev/docs/proxy
- https://exe.dev/docs/cli-new (and sibling CLI reference pages)
- https://exe.dev/docs/billing/overview, /usage, /cloud-pool
- https://exe.dev/docs/regions
- https://news.ycombinator.com/item?id=47878211 (pricing discussion)

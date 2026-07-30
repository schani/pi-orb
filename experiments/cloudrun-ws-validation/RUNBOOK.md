# Cloud Run WebSocket validation runbook

Validates DESIGN.md open question 2 (and, as a side effect, the COS +
Artifact Registry container path the GCE provider will use). Everything is
throwaway; the cleanup section removes it all. All commands pass
`--project` explicitly — the local gcloud default points at an unrelated
project and must not be changed.

```bash
export PROJECT=playground-dev-6ae7
export REGION=us-central1
export ZONE=us-central1-a
export DIR=experiments/cloudrun-ws-validation
```

## 0. One-time setup

```bash
gcloud services enable run.googleapis.com compute.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com \
  --project $PROJECT
```

## 1. Browser-leg test: default timeout, then 60-minute timeout

Deploy with the **default** request timeout first to observe the 300 s
forced close, then raise it and observe the 3600 s close.

```bash
gcloud run deploy ws-validation --source $DIR \
  --project $PROJECT --region $REGION --allow-unauthenticated
URL=$(gcloud run services describe ws-validation --project $PROJECT \
  --region $REGION --format='value(status.url)')

# Expect: close at ~300 s, immediate successful reconnect.
node $DIR/client.mjs "${URL/https:/wss:}/ws" 420

gcloud run services update ws-validation --project $PROJECT \
  --region $REGION --timeout 3600

# Expect: close at ~3600 s, immediate successful reconnect. Run in background.
node $DIR/client.mjs "${URL/https:/wss:}/ws" 3900
```

Record: observed close times, close codes, reconnect gaps.

## 2. VPC-egress leg: Cloud Run → COS VM over internal IP

The Cloud Build image from step 1 is reused for the VM container so this
also validates the COS container path.

```bash
IMAGE=$(gcloud run services describe ws-validation --project $PROJECT \
  --region $REGION --format='value(spec.template.spec.containers[0].image)')

gcloud compute instances create-with-container ws-validation-vm \
  --project $PROJECT --zone $ZONE --machine-type e2-small \
  --container-image "$IMAGE" --container-env PORT=8080 \
  --no-address   # internal IP only; proves egress needs no public IP on the VM

VM_IP=$(gcloud compute instances describe ws-validation-vm --project $PROJECT \
  --zone $ZONE --format='value(networkInterfaces[0].networkIP)')

# Allow Cloud Run's VPC-egress traffic to reach the VM.
gcloud compute firewall-rules create allow-ws-validation \
  --project $PROJECT --network default --allow tcp:8080 \
  --source-ranges 10.0.0.0/8

# Attach the Cloud Run service to the VPC (Direct VPC egress).
gcloud run services update ws-validation --project $PROJECT --region $REGION \
  --network default --subnet default --vpc-egress private-ranges-only

# Start the outbound probe from inside Cloud Run and watch it.
curl -X POST "$URL/vm-probe?url=ws://$VM_IP:8080/ws"
curl "$URL/vm-probe"   # repeat over hours; `closes` records every drop
```

Record: whether the WS connects at all, connection lifetimes (Cloud Run
instance replacement will drop it — expected), reconnect behavior.

Note: with `--no-address` the VM cannot pull from Artifact Registry unless
the subnet has Private Google Access enabled:

```bash
gcloud compute networks subnets update default --project $PROJECT \
  --region $REGION --enable-private-ip-google-access
```

## 3. IAP: availability and WebSocket pass-through

Check whether direct IAP-on-Cloud-Run is available (no load balancer):

```bash
gcloud run services update ws-validation --project $PROJECT --region $REGION --iap
# or: gcloud beta run services update ... --iap
```

If the flag exists: grant `roles/iap.httpsResourceAccessor` to the owner
account, open $URL in a browser, confirm the Google login interstitial,
then confirm a WS connects from the browser dev console:
`new WebSocket("wss://<host>/ws")` and watch ticks arrive. If the flag
does not exist, record that the two-service design must protect the
browser service another way (LB + IAP with app-level assertion checks —
see DESIGN.md §15.1 for why LB+IAP alone was rejected).

## 4. Billing observation

Leave the service at min-instances 1 with instance-based billing and an
idle WS overnight; confirm the cost matches the always-on instance price
and does not scale with open sockets.

```bash
gcloud run services update ws-validation --project $PROJECT --region $REGION \
  --min-instances 1 --no-cpu-throttling
```

## 5. Cleanup

```bash
gcloud run services delete ws-validation --project $PROJECT --region $REGION --quiet
gcloud compute instances delete ws-validation-vm --project $PROJECT --zone $ZONE --quiet
gcloud compute firewall-rules delete allow-ws-validation --project $PROJECT --quiet
```

## Results (2026-07-29/30)

**Deviations from the runbook.** Cloud Build is unusable in this project
(the default compute service account is disabled), so the image was built
locally and pushed to Artifact Registry (`pi-orb` repo, Dockerfile added).
The project also has no default VPC: a custom `pi-orb` network with subnet
`pi-orb-us-central1` (10.10.0.0/20, Private Google Access on) was created —
the OpenTofu static plane should adopt exactly this shape.

**1. Browser leg.**
- Default request timeout: forced close at **301.2 s**, code 1006;
  reconnect succeeded after 1.1 s against the same instance. The 300 s
  default silently breaks live sessions — raising `--timeout 3600` is
  mandatory.
- With `--timeout 3600`: one connection survived the full hour, forced
  close at **3601.1 s**, code 1006, reconnect in 1.1 s. Exactly the
  resync-handled behavior DESIGN.md assumes.

**2. VPC egress to a COS VM.**
- `--network pi-orb --subnet pi-orb-us-central1 --vpc-egress
  private-ranges-only` deployed cleanly; the outbound WebSocket to
  `ws://10.10.0.3:8080/ws` (internal IP, VM has **no external IP**)
  connected immediately and streamed ticks.
- Bonus validations for the GCE provider path: COS pulled the container
  from Artifact Registry via Private Google Access, running as the
  dedicated minimal service account `pi-orb-orb-vm` (Artifact Registry
  reader + log writer only). The first attempt with the default compute
  SA failed — that SA is disabled project-wide, so the provider must
  always pass the dedicated SA.

**3. IAP.**
- Direct IAP-on-Cloud-Run is available: `gcloud run services update
  --iap` worked (after enabling `iap.googleapis.com`). Unauthenticated
  requests get `302 Invalid IAP credentials`. `mark@heyglide.com` holds
  `roles/iap.httpsResourceAccessor` on the service. Browser WebSocket
  pass-through remains to be eyeballed interactively.
- Consequence: the two-service plan stands and the load-balancer+IAP
  fallback is unnecessary.

**4. Overnight observations (2026-07-30).**
- Egress longevity: the Cloud Run → VM WebSocket stayed connected for
  **11.4 hours (40,883 s, 2,725 ticks, zero drops)** until a deploy
  replaced the instance. Outbound connections are not subject to the
  request timeout; the control-plane→runtime leg only drops on instance
  replacement, exactly as designed.
- The min-instance also survived the whole night without replacement
  (single instance uptime > 11 h).
- IAP WebSocket pass-through confirmed interactively: after Google
  sign-in, `wss://…/ws` delivered hello and tick frames in the browser.
- IAP access policy tightened to `domain:heyglide.com` only (the sole
  `iap.httpsResourceAccessor` binding).
- Billing: confirmed via the Cloud Monitoring metric
  `run.googleapis.com/container/billable_instance_time` — a flat 1.00
  instance-second/second every hour for 12+ hours regardless of open
  WebSockets (brief 1.16 during a revision replacement). Open sockets
  add nothing under instance-based billing; cost is the always-on
  instance's flat rate (~$50/month at list price for 1 vCPU / 512 MiB).

**Teardown (2026-07-30).** Service, VM, and the validation firewall rule
are deleted. Kept for the OpenTofu static plane to adopt: VPC `pi-orb`,
subnet `pi-orb-us-central1`, service account `pi-orb-orb-vm`, and the
`pi-orb` Artifact Registry repository.

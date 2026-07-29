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

## Results

(filled in as the exercise runs)

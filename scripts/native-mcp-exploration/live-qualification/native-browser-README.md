# Real native-browser qualification (isolated local authority)

The launcher uses the stock control plane, reconciler, GCE provider, runtime HTTP/WS proxy, PGlite and existing auth. Only the fenced Compute transport substitutes the test VM's ownership label (`pi-orb-orb-id` ↔ `pi-orb-native-browser-orb-id`) and maps the stock logical `pi-orb-<orbId>-iN` to the physical `pi-orb-validator-<orbId>-iN` on Compute requests, reversing names on reads. The production orphan sweeper cannot claim it. All Compute requests are restricted to this fresh orb, its disk, pinned images and one project/zone. `computeLog` records collection, method, status and error code, not bodies or tokens.

This fixture-only mapping uses the existing authorized validator IAM scope; it does not qualify production VM naming, IAM, path rules, or direct private-VPC connectivity. No fixture network tags, firewall rules, service account permissions, credential copies, mock inference, or MCP catalog are required. **This tests browser→control-plane→real guest over an existing IAP SSH tunnel, not direct private-VPC connectivity.** Browser WS uses the stock control-plane proxy. Guest broker reaches the stock local control plane through SSH remote forwarding. Model authority stays in the existing local auth directory.

Parent operator:

1. Archive old stopped process orb `358131f1-a47c-4a6d-9b9a-43e49dd2df7c` using the old backend and stop that backend. Launcher rejects any remaining host reference or active reused fixture project. It permits restarting the original config solely to finish deletion when that project is already `deleting` and all its orbs are archived or deleting, host-free, and match the configured orb. This cleanup-only run fences Compute to owned reads/deletes and operation waits; do not create another fixture. Do not touch unrelated orbs.
2. Build/accept runtime and workspace images after production source is frozen; record their exact image resources and numeric IDs. Existing ADC must permit Compute; existing IAP SSH/OS Login identity must already connect to this fixture. Do not widen IAM or firewall. Use `pi-orb-build` (the accepted image's normal UID with locked password) for metadata-backed SSH; use the available OS Login identity if required.
3. Create fresh UUIDs for `orbId`, `projectId`, `connectionNonce`; choose a private absolute `connectionMap` path (not present at startup) and `computeLog` path. Write nonsecret config (0600, outside git):

```json
{
  "projectId": "<fresh UUID>", "orbId": "<fresh UUID>", "connectionNonce": "<fresh UUID>",
  "connectionMap": "/absolute/private/path/connection.json",
  "gcpProject": "playground-dev-6ae7", "zone": "us-central1-a",
  "gceServiceAccount": "pi-orb-orb-vm@playground-dev-6ae7.iam.gserviceaccount.com",
  "subnetwork": "regions/us-central1/subnetworks/pi-orb-us-central1",
  "runtimeImageResource": "projects/playground-dev-6ae7/global/images/<accepted-runtime>",
  "runtimeImageId": "<numeric ID>",
  "workspaceImageResource": "projects/playground-dev-6ae7/global/images/<accepted-workspace>",
  "workspaceImageId": "<numeric ID>",
  "brokerUrl": "http://127.0.0.1:7100",
  "appOrigin": "http://127.0.0.1:5173", "computeLog": "/absolute/private/path/compute.jsonl",
  "port": 7100, "generation": 0
}
```

4. Run `node --test scripts/native-mcp-exploration/live-qualification/native-browser-{fence,transport}.test.mjs`. The launcher preserves inherited workload identity (including `PI_ORB_GCP_AUDIENCE`) but discards inherited app/fake routing configuration. Parent starts `node scripts/native-mcp-exploration/live-qualification/native-browser-main.mjs <config.json>` at repo root. Start Vite separately in its normal backend proxy mode on 5173, **not** `--mode frontend` (mock). The backend listens on localhost:7100; do not put secrets in argv or environment.
5. Using the real API/browser, create exactly the configured project/orb. Watch the scoped `computeLog` and list/describe **only** `pi-orb-validator-<orbId>-i<digits>` in the configured project/zone. Before forwarding, confirm the VM's `pi-orb-native-browser-orb-id` label matches `orbId`, its physical name matches the expected fixture incarnation, and its private `networkInterfaces[0].networkIP` is an IP address. Never guess the IP from a fake response. Once the owned VM appears, start an IAP SSH tunnel to that exact instance promptly (guest boot-context retries for 180 seconds): `gcloud compute ssh <available-user>@<owned-instance> --project=<gcpProject> --zone=<zone> --tunnel-through-iap --ssh-flag=-oExitOnForwardFailure=yes --ssh-flag=-N --ssh-flag=-R127.0.0.1:7100:127.0.0.1:7100 --ssh-flag=-L127.0.0.1:18880:127.0.0.1:8080`. Confirm both forwards. If remote forward fails or OS Login denies SSH, stop and report; do not modify IAM/firewall.
6. Atomically publish the **nonsecret** 0600 connection map only after verifying ownership and forwarding: write `<connectionMap>.tmp` and rename to `<connectionMap>`, with exactly `{ "orbId": "<config orbId>", "projectId": "<config projectId>", "connectionNonce": "<config connectionNonce>", "privateIp": "<verified networkIP>" }`. The launcher routes only this exact destination IP:8080 to localhost:18880; other sockets remain untouched. Remove the map if the verified VM or tunnel disappears. Keep the same map only while the owned incarnation remains; repeat ownership verification for replacements.
7. Submit a real Sol root+child/codemode turn and verify browser handshake, history, model request, tools and outcome in the product/runtime records. A synthetic SDK fixture is not qualification. Retain only scoped Compute statuses and lifecycle edges, not prompt or credential values. Stop/archive the owned orb via API and verify its VM/disk are gone; remove the map, stop SSH and local backend. Never bulk-delete Compute resources. If cleanup fails, preserve evidence and fence for investigation.

# Native VM production-provider experiment

Recorded run: `docs/native-vm-prototype.md`. These probes exercise the production native-image
provider against disposable resources. Resource names in the cloud/identity probes
belong to the 2026-09-05 disposable fixture; use fresh names and trust scope for a
new run. Set `NATIVE_INTEGRATION_ROOT` to a private evidence directory;
retain failures there.

`main.mjs` runs the stock control plane with isolated PGlite/file credentials and
mock model/OAuth sessions. `api.mjs` makes authenticated Compute requests through
the VM's service account, fences every operation to the fixture orb and translates the instance ownership
label. That separate
label is essential: a production orphan sweeper otherwise stops the test VM.
The provider, runtime transport, reconciler, token rotation and fingerprint logic
remain the production implementations.

The test control-plane VM runs in `pi-orb-run-egress`, with the existing control
plane service account. Orbs use `pi-orb-us-central1`, the existing orb VM account,
and the existing private runtime firewall. A disposable tag-scoped firewall
allows only test orb → test control plane on 18100. IAP/SSH exposes the control
plane to the local driver on 18100; private runtime/broker traffic needs no tunnel.
An optional 18080 diagnostic tunnel follows the current orb IP.

Build and validate the image with `npm run native-image:build -- …`
(`infra/native-vm/README.md`). Copy its accepted manifest image resource and ID
into the fixture. Grant the control-plane
service account `roles/compute.imageUser` on each test image. Publish only the
public test signing JWKS for federation; the private key stays in the isolated
broker. Restrict its temporary WIF provider/account to the fixture orb/project.

`prepare.mjs` creates the model fixtures and private GitHub/Tailscale credential
copies. Install the source and control-plane dependencies on the test VM; launch
`main.mjs` as a supervised service. Do not print or package those credential copies
in an image. `control.mjs admit|stop|start|ready|failed|delete` drives the public API.

After ready, run `optin-check.sh` as root before any Docker request. Then run
`NATIVE_VM_EVIDENCE=.context/native-vm-integration node e2e/native-vm/check.mjs`.
Copy `application-check.sh`, `identity-check.py` and `infra/native-vm/workload.sh`
to `/workspace`, where they survive reboot. `terminal.mjs` runs commands through
the normal terminal WebSocket with the orb's user/credential environment:

```sh
node e2e/native-vm/integration/terminal.mjs \
  'bash /workspace/application-check.sh' .context/native-vm-integration/applications.log
node e2e/native-vm/integration/terminal.mjs \
  'python3 /workspace/identity-check.py' .context/native-vm-integration/identity.log
node e2e/native-vm/integration/terminal.mjs \
  'bash /workspace/workload.sh seed' .context/native-vm-integration/seed.log
```

Run each terminal/protocol probe to completion before restarting the control
plane or performing another lifecycle action.

After Stop/Start and `preemption.mjs`, assert Docker remains off, then explicitly
start it before `workload.sh verify`. For image replacement, change fixture image
and generation, restart the same control plane/database, assert the running VM
is untouched, then Stop/Start. Verify incarnation, token fencing, retained state
and fresh federation. Use two independently built, accepted images for replacement.
This checks lifecycle selection and retained storage, not a Docker engine upgrade.

Cleanup order: export domain history, API/audit/guest logs; delete the fixture
project through the API; verify its VM/data disk and Tailscale identity are gone.
Remove the test control plane/builders/images, temporary firewall rules, issuer
service/container image, WIF pool/provider and service account grants/account.
Delete model fixtures and local credential copies; stop tunnels/browser sessions.
Never run a project-wide instance cleanup or revoke the user's GitHub credential
or the production Tailscale OAuth secret.

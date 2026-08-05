# Cloud deployment direction

Decisions about where the control plane runs and how infrastructure is managed. The operational workflow (build, apply, deploy, gotchas) lives in `infra/README.md`.

- The cloud control plane is expected to run on Cloud Run.
- At least one Cloud Run instance must remain provisioned so active-orb history polling can run continuously.
- The polling process must use always-allocated CPU/instance-based billing; a minimum instance with request-only CPU allocation is insufficient for reliable background work.
- Polling state and cursors remain in PostgreSQL because Cloud Run may restart even a minimum instance at any time.
- Multiple control-plane instances may poll the same orb concurrently. Correctness uses an optimistic cursor compare-and-swap in the commit transaction rather than a distributed polling lock or leader.
- Cloud Run WebSocket configuration is validated (open question 2): the platform behaves exactly as the architecture assumes once the request timeout is raised to 3600 s, and no VM fallback is needed.
- The cloud control plane sits behind Identity-Aware Proxy restricted to the `heyglide.com` Google Workspace domain (`domain:heyglide.com` as the sole `iap.httpsResourceAccessor`; hardcoded for now) until an application identity/authorization model exists (open question 24). The unauthenticated control plane must never be directly reachable from the public internet. Validated interactively: browser WebSockets pass through IAP after sign-in.
- Infrastructure must be managed as code.
- The IaC tool is OpenTofu. It manages only the static plane: VPC, firewall rules, Cloud Run, Cloud SQL, Artifact Registry, IAM. Per-orb VMs are dynamic resources created by `GceOrbHostProvider` through the GCE API at runtime and are never IaC resources.
- OpenTofu state lives in GCS (versioned bucket `pi-orb-tfstate-playground-dev-6ae7`, prefix `static-plane`), decided 2026-08-01 after the original local state was lost with its working directory. The live deployment was adopted into the fresh remote state via import blocks (`infra/imports.tf`) — 17 imports, zero destroys — rather than torn down; the import blocks stay in the repo as the adoption record. Lesson encoded: local IaC state in an ephemeral checkout is how you lose it.
- The control plane, orb runtime, shared protocol, and web UI will be written in TypeScript on Node.js 24.

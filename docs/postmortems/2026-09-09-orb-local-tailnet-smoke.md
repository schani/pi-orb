# Orb-local release smoke assumed kernel tailnet networking

## Finding (2026-09-09)

Release `a02638e` passed native image acceptance and applied exactly four Cloud Run service updates using the scoped federated deployer. IAP was reconciled to the exact accessor allowlist and the drained browser revision was deleted. The subsequent lifecycle smoke created orb `7fc535b3-d734-40de-a13c-fb6d320da539` in project `3401fc41-4629-4f7c-90dd-cea37e28d243`; it reached `running` in 56 seconds, but the preview-health leg failed after its unchanged 60-second deadline with HTTP `000`. The release returned 1 after apply; the application was live, but the remaining gates were not yet validated.

The first failure is preserved in `.context/release-a02638e/release.log`. Diagnosis against that same running fixture established:

- `tailscale status --json` reported the peer online and the caller's `TUN` as `false`.
- Direct curl consistently failed with exit 6: the host resolver could not resolve the peer's MagicDNS name.
- This orb runs `tailscaled --tun=userspace-networking`, so peer visibility does not imply host DNS or a kernel TCP route into the tailnet.
- Dialing the exact same hostname and port through `tailscale nc` returned HTTP 200 with `status: ready`. The product endpoint was healthy.
- A naive `printf request | tailscale nc` returned no response: this CLI exits on stdin EOF. Keeping stdin open until the peer closes the HTTP connection made the response deterministic.

Evidence is in `.context/release-a02638e/tailnet/{reproduction,nc-held-open,corrected-probe}.log`. This was a smoke-harness environmental assumption, not random network noise or a reason to extend deadlines.

## Correction

The preview smoke reads the daemon's `TUN` field. Kernel clients retain direct curl; userspace clients use `infra/smoke_preview.py` to dial through `tailscale nc`, bypassing host DNS/routing. The helper sends HTTP/1.1 with `Connection: close`, keeps the request pipe's writer owned by the parent until nc finishes, and uses the standard HTTP parser for content-length and chunked responses. Its subprocess deadline remains ten seconds; timeout kills and reaps the child. Parent exit closes the pipe, so nc is not left waiting for input. No proxy listener, new daemon, machine-wide DNS change, skip, or larger timeout is introduced. Missing/invalid daemon mode is an explicit failure.

Unit tests deterministically assert non-EOF stdin ownership, request framing, content-length/chunked parsing, non-200 propagation, malformed/truncated responses, process errors, timeout mapping, and hostname rejection. Source contract tests pin userspace/kernel selection and unchanged health deadlines. Both transports retain a useful final error instead of suppressing curl's DNS failure. The corrected helper returned ready against the original failed fixture before a new smoke was attempted.

While verifying through the ops helper, its bearer header was moved from curl arguments to curl configuration on stdin (`infra/api.sh`), keeping the temporary Google identity token out of process listings. A source contract pins that property.

With harness commit `fb8b465` and the global release lock held, the full lifecycle gate passed in 221 seconds, including userspace preview health and stop/start/stop. The next workload-identity gate failed during fixture boot amid interference from the deleted old browser revision; it was not retried. No new application apply was performed. All owned smoke projects were subsequently confirmed absent and the lock was removed. The release is still not fully validated; the separate failure is recorded in `docs/postmortems/2026-09-09-deleted-browser-reconciler.md`.

# Dependency audit

How to audit dependencies, where external inputs are pinned, and the open findings of the latest audit. Version lines and dependency rules: `docs/stack.md`.

## Method

Run from a clean checkout with one exclusive install/check owner per tree; a concurrent `npm ci` can delete dependencies another check is reading (`docs/postmortems/2026-10-16-dependency-audit-validation-collision.md`).

```sh
npm ci
npm audit --json
npm outdated --all --json   # exit 1 normally means updates exist
npm view <name> dist-tags time engines peerDependencies --json
npm view <name>@<locked-version> version engines peerDependencies deprecated --json
curl -fsSL 'https://registry.npmjs.org/<URL-encoded-name>'
gh api repos/<owner>/<repo>/releases/latest
```

- **Inventory.** Enumerate `dependencies` and `devDependencies` in every manifest, excluding private `@pi-orb/*` workspace links. Resolve each name from its importing directory through the nearest ancestor `node_modules/<name>` record in the lockfile's `packages` map; never substitute the manifest's `^` floor or a root-hoisted copy. Separately enumerate every lock record to keep nested duplicates. Standalone locks under `scripts/` are separate graphs.
- **Record** query time, dist-tags, publication dates, engines, peers, lockfile hash and release URLs. The commands reproduce the method, not a past registry snapshot.
- **Usage.** Peer satisfaction, executable invocation and fixture-only use are real uses; an import-only scan cannot prove a dependency dead.
- **Interpretation.** "Latest" is the registry's stable `dist-tags.latest`, not `next` and not a claim that a newer major suits pi-orb. Freshness is not support or safety. An empty advisory response is not proof of safety: ingestion lags, and it does not cover misuse, local patches, OS/container packages, downloaded binaries or supply-chain compromise. Graph inclusion establishes neither reachability nor deployed exposure. Node's bundled Undici is a separate supply chain from npm's.
- **Remediation.** Fix at the owning edge (owner update or an owner-scoped override); no global matcher overrides, transitive-major forcing or arbitrary transitive deletion.
- **Updates** need a lock diff, clean installs with postinstall patches and the gates in `docs/testing.md`. Pi family updates also need a patch rebase (`docs/pi.md`); native/image inputs need cold builds and retained-store checks (`docs/host-provider.md`); any persisted-state change needs user discussion first.

## External inputs

These are pinned outside npm; audit them by reading the pin site.

| Input | Pin site |
|---|---|
| Node.js archive and Docker base tags | `.github/workflows/*.yml`, `apps/*/Dockerfile`, `infra/native-vm/install.sh` |
| npm | root `package.json` `packageManager` (installed explicitly everywhere) |
| OpenTofu, Google/random providers | `.github/workflows/{ci,deploy}.yml`, `infra/**/.terraform.lock.hcl` |
| gcloud SDK | `.github/workflows/deploy.yml` |
| GitHub Actions | exact SHAs in `.github/workflows/*.yml` |
| GCE base image, Debian/Docker/containerd/guest-agent packages, rustup, Bun, git-crypt | `infra/native-vm/install.sh`, `infra/native-vm/PACKAGES.md`, `infra/install_*.sh` |
| PostgreSQL major | `infra/sql.tf`, `docker-compose.yml` |
| Fake provider (`glideapps/fake-openai`, Fling) | `scripts/local-fake-provider.mjs` |
| Fonts | `apps/web/public/fonts/manifest.json` (below) |

Floating APT packages (`gh`, Chromium, buildx/compose plugins, Google Cloud CLI in the guest) have no source-provable installed version. Debian 12 security updates are preferred over bespoke upstream builds. Third-party APT keys are fetched over HTTPS without separately pinned fingerprints. Cloud services, GitHub and model/OAuth endpoints are external contracts, not versioned libraries.

## Open findings

From the latest audit, still current:

- **PGlite is held** at engine 0.5.12 / `pglite-pg_textsearch` 0.0.14 behind registry latest, and native `pg_textsearch` at Cloud SQL's 1.3.1, by the extension policy in `docs/history.md` ("Search"). Registry freshness does not authorize an upgrade.
- PostgreSQL 17 is current on its supported major; no move to 18 is needed.

## Pinned assets

Product fonts are Iosevka Etoile 34.9.1 (tag commit `cea353b17b9b5c6e22da4f0fcae66f16d68a4edf`) and JetBrains Mono 2.304; the DejaVu Sans Mono E2E fixture is fixed and never refreshed automatically. Unhinted Iosevka webfont archives match the GitHub release-asset digests and the publisher's [SHA-256.txt](https://github.com/be5invis/Iosevka/releases/download/v34.9.1/SHA-256.txt):

| Archive | SHA-256 |
|---|---|
| [PkgWebFont-Unhinted-Iosevka-34.9.1.zip](https://github.com/be5invis/Iosevka/releases/download/v34.9.1/PkgWebFont-Unhinted-Iosevka-34.9.1.zip) | `7ad47936ff8a476d15858cb68535c5ec376cd4b384d2f68d556b8a7e62b406a4` |
| [PkgWebFont-Unhinted-IosevkaAile-34.9.1.zip](https://github.com/be5invis/Iosevka/releases/download/v34.9.1/PkgWebFont-Unhinted-IosevkaAile-34.9.1.zip) | `a861abf4f624f659081768486be82e54b0a2c8764e4f0ff499e998403a0c5f4a` |
| [PkgWebFont-Unhinted-IosevkaEtoile-34.9.1.zip](https://github.com/be5invis/Iosevka/releases/download/v34.9.1/PkgWebFont-Unhinted-IosevkaEtoile-34.9.1.zip) | `d8d9c490b1e014a825dd309d2c754717a86bb0b51f66b5e188effd9109646d7e` |

Subsets (FontTools/Brotli) keep the existing 1,809-codepoint cmap, all layout features, glyph names and name records; product hashes are in the manifest, and the OFL text matches the tagged license. Updating a font means regenerating the renamed licensed subsets, CSS and hashes and rerunning real loading/shaping/terminal-column tests. `apps/web/src/components/HarnessIcon.tsx` vendors Claude's asterisk SVG from [Simple Icons](https://simpleicons.org/) (CC0).

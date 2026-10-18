# Git identity

**Requirement (2026-10-12):** set the user's git identity (`user.name`, `user.email`) in account Settings so every orb commits as that user. Before this, orbs had no identity; the image's system gitconfig carries only the GitHub credential helper. The user requested five design proposals before selecting one.

**Decision (2026-10-12):** the user selected proposal 1, Git tab, with "keep it as simple as possible". Proposals 2–5 remain rejected alternatives below.

## Five proposals (2026-10-12)

Interactive study: [`design-prototypes/git-identity.html`](../design-prototypes/git-identity.html); side-by-side matrix: [`design-prototypes/git-identity-comparison.html`](../design-prototypes/git-identity-comparison.html). The study has the current product stylesheet and fonts embedded. All data and saves are simulated in browser memory.

1. **Git tab — recommended smallest; selected.** Settings tabs become Instructions / Git / Claude. Two fields named `user.name` and `user.email`, explicit Save, `Saved · next orb start` receipt, same draft/focus rules as Instructions. Identity only.
2. **`~/.gitconfig` file.** The Git tab is a raw gitconfig editor, parallel to `~/AGENTS.md`. Covers aliases and preferences too; costs syntax validation and broader scope.
3. **Pick a source.** Google sign-in identity, GitHub noreply address, or Custom fields. One click for the common case; GitHub noreply keeps the real address out of public history. Requires connection-derived values kept current and a disabled state when GitHub is disconnected.
4. **Dashboard signature.** The totals strip shows `Name <email>` beside the gear and edits in place; unset shows only an icon. Always visible; costs a permanent strip cell (a row on phones) and a one-line parse.
5. **Default + project override.** Option 1 plus per-field overrides in project Config General, inheriting the account value. Supports work/personal splits; adds a second scope.

## Delivery

At boot the runtime reads the owner's identity and writes git's XDG global file, creating an empty `~/.gitconfig` if absent. `~/.gitconfig` and repository config take precedence, and in-orb `git config --global` writes to `~/.gitconfig`, so those edits survive. Without an existing `~/.gitconfig`, git 2.39 writes `--global` changes into the XDG file, which the next boot would overwrite (verified 2026-10-12). Git 2.39 `git config --global <key>` reads only `~/.gitconfig` once it exists; ordinary reads and commits see both files. Adoption happens at the next orb start; saving never wakes or restarts compute. The proposed history edge (applied revision and hash, as in `docs/personal-instructions.md`) was dropped for simplicity (2026-10-12): there are no revisions.

## Implementation (2026-10-12)

- Settings tabs: Instructions / Git / Claude. Git has labeled `user.name` and `user.email` inputs and the Instructions status/Save/Retry behavior: loaded when the dialog opens, draft kept in component memory, pending save locks closing, tabs and fields. `apps/web/src/components/GitIdentitySettings.tsx`.
- Contract (`packages/protocol/src/git-identity.ts`): `{name, email}`, both empty (cleared) or both set, each ≤ 256 characters, no control characters, unpaired surrogates, `<` or `>`. A set email must look like `local@domain.tld` (no whitespace, one `@`, dotted domain; user request 2026-10-12).
- Storage: migration `042_git_identities.sql`, one row per `user_id` with `updated_at`. A missing row reads `{name: "", email: ""}`. Last-write-wins PUT; no revisions or CAS.
- `GET`/`PUT /api/v1/git-identity` for the signed-in user, `no-store`, with the personal-instructions ops `X-Pi-Orb-User-Id` rule. `GET /runtime/v1/git-identity` derives `orb → project → owner` from the active-incarnation bearer; no runtime write.
- Boot (execution runtime and the host-native Claude harness): after the project-secrets fetch has passed bootstrap authentication and before the resume hook, one bounded request (10 s); then `git config --file <xdg> --replace-all` per set key or `--unset-all` per cleared key (exit 5 = already absent), where `<xdg>` is `$XDG_CONFIG_HOME/git/config` or `~/.config/git/config`. Other keys in that file are preserved. git runs with the orb home as its working directory: git 2.55 aborts (`fatal: error reading '<cwd>/.git'`) when the inherited directory is unreadable, which failed the sandboxed Claude acceptance on CI (PR 77) while local git 2.39 passed. Then `~/.gitconfig` is created empty if missing, never truncated. The process provider drops an inherited `XDG_CONFIG_HOME`, so a local orb never writes the developer's git config.
- Observability: the stored row is queryable in `git_identities`. A failed read or write fails boot with `git_identity_unavailable` through the existing orb failure reporting; it never boots silently without the identity. No history edge.
- No state machine, retry or reconciliation is introduced, so there is no DST scenario. Tests: protocol validation, real PGlite store contract, browser/runtime route tests, real-git boot tests (`apps/orb-runtime/src/execution/boot.test.ts`) and the Chromium/WebKit browser test `e2e/git-identity-frontend.e2e.test.ts`.

**Qualification (2026-10-12; uncommitted, undeployed):** typecheck and lint pass (existing warnings only). `npm test`: 4,257 passed, 19 skipped; the only failures are the five `durable-pg` real-PostgreSQL tests that need `127.0.0.1:55432` (tracked in `TODO.md`); infrastructure suites pass. A first full run also timed out one PGlite store-contract `beforeEach` (10 s) because a Chromium/WebKit run shared the two-core host; isolated, that file passes (slowest case 3.2 s), and the unshared full run did not reproduce it. Chromium/WebKit `git-identity`, `personal-instructions`, `claude-connection` (34) and `frontend-mobile` (96) browser tests pass. Lifecycle E2E (`npm run test:e2e`) was not run; it is required before deployment because boot changed.

## Prototype checks

`design-prototypes/git-identity.smoke.mjs` exercises all five entry points at 1440px and 390px: edit, validation, injected save failure with draft retention, held save, receipt, Escape/backdrop/focus, source switching with GitHub disconnected, signature Enter/Escape/parse error, project inherit/override, phone 16px text and 48px targets, horizontal containment, and script errors. Passed 2026-10-12. Qualifies the static study only.

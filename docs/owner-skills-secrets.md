# Owner skills and secrets

**Requirement (2026-10-26):** the owner adds skills (single `SKILL.md` files for now) and secrets outside any project; they apply to all of the owner's projects.

**Status (2026-10-26): Settings tabs selected (question 83); deployed 2026-10-26 (Deploy run 40277646564, `c812b034`).**

## Decisions (2026-10-26)

- **Surface:** proposal 1. The dashboard gear's Settings has Instructions · Skills · Secrets · Git · Claude. The Secrets tab is the project Secrets component (`ProjectSecretsSettings`) itself, not a lookalike; the Settings frame's `.personal-instructions-dialog form` column rule is scoped to the Instructions editor so it cannot restack the secret form. Skills reuse the MCP workbench disclosure: one row per skill expanding to its raw `SKILL.md`, explicit Save, `Saved · next orb start`.
- **Scope and adoption:** owner-scoped like personal instructions (`docs/personal-instructions.md`). Every orb of every project the owner has receives them at the next agent-context open / orb start. Saving never wakes, restarts or interrupts an orb.
- **Secrets:** write-only environment variables with the project-secret name rules, reserved names and limits (`docs/credentials.md`). The project-secret domain logic is generalized, not forked: owner bundles `{userId, revision, values}` live in their own GSM parent `pi-orb-credential-user-secrets`; `user_secret_pointers` holds metadata and the exact version. The existing runtime secrets route returns owner values overlaid by project values, so **a project secret with the same name wins** and the runtime is unchanged. MCP bearer references remain project-only.
- **Skills:** stored one row per skill in `user_skills(user_id, name, content, updated_at)`; no revision column. Name and description come from the frontmatter (no separate name field), parsed with Pi's strict YAML parser: name `^[a-z0-9]+(-[a-z0-9]+)*$` ≤ 64, description ≤ 1024, content ≤ 64 KiB, at most 100 skills. `POST /api/v1/owner-skills` creates; `PUT /api/v1/owner-skills/:name` replaces and renames in one transaction when the frontmatter name differs; `DELETE` removes. Bundled platform skill names are rejected at save.
- **Precedence (user decision):** **owner skills win** over same-named repository skills, silently, in both harnesses. Pi omits the repository skill; Claude Code's native personal-over-project rule gives the same result for skills materialized into its user skills directory.
- **Rejected simplifications of an earlier plan:** a single jsonb row per user (needs CAS for two concurrent edits; one `SELECT` already gives a consistent set), an owner-skills adoption history record (Pi already persists the rendered skill inventory in the prompt section), a shadowing warning, a 1 MiB total cap, a separate owner-secrets runtime route, and a duplicated secrets domain.

This reverses the earlier Pi resource-scope decision that user-level skills are outside required resource scope (`docs/pi-durable-evaluation.md`).

## Five configuration proposals (2026-10-26)

Interactive study: [hosted](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/6e16dc75-2326-4f5a-bbfd-853e5ce5fcd0/design/global-skills-secrets/index.html). It links a snapshot of `apps/web/src/styles.css` and reuses captured production markup: dashboard totals/masonry columns, the 560px Settings/Config frame and tabs, the MCP workbench disclosure and the Secrets pane. State is in memory only.

1. **Settings tabs.** The dashboard gear's Settings gains Skills and Secrets tabs (Instructions · Skills · Secrets · Git · Claude). Skills reuse the MCP disclosure, one row per skill expanding to its `SKILL.md`; Secrets is the project Secrets pane unchanged. Smallest; long skills are edited in 560px and five tabs are tight on a phone.
2. **Inherited in project Config.** No owner-level entry point. Each project's Config shows the effective set: own secrets, then "all projects" secrets, struck through where overridden. The secret form gains a scope choice; a Skills tab lists owner skills. Shows exactly what an orb receives; repeats the scope confusion rejected for personal instructions.
3. **All-projects box.** A permanent first board box built like a project column: skills and secrets with + per group; rows open the 560px sheet. Always-visible inventory; costs a column and resembles a project.
4. **Totals counters.** `N skills` and `N secrets` totals open dedicated sheets; Skills uses a wider list | editor sheet. Mixes configuration counts with fleet state; phone totals grow to three rows.
5. **All-projects page.** A layers icon beside Usage opens an addressable page with a 236px index and full-height editor; each skill has a URL, and missing skills show a resource-specific message. Most writing room; adds a route and leaves the board.

Browser smoke checks (2026-10-26, Chromium, 1440px and 390px): no horizontal overflow; frontmatter validation, failed-save draft retention and save receipt; secret add; project-scope override; sheet open/close; missing-skill page.

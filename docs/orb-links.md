# Orb links

The agent registers GitHub pull requests, issues and Actions runs it is working on. The orb header shows them in a Links drawer with live GitHub status. Only the user removes a link.

## Registering

Central Pi calls the `orb_link({url})` tool; Claude runs `pi-orb link <github-url>`, which calls `PUT /runtime/v1/orb/links` with `{url}` and the runtime bearer (the CLI also works from central execution hosts). Both reach `addOrbLink` (`apps/control-plane/src/domain/orb-links.ts`). The shared environment prompt tells the agent to use its harness's tool whenever it opens a GitHub PR, issue or Actions run. The control plane accepts `https://github.com/<owner>/<repo>/{pull|issues|actions/runs}/<number>` and canonicalizes it (scheme, `www.`, trailing path, query and fragment dropped; `canonicalGithubLink` in `packages/protocol/src/orb-links.ts`). Saving an existing link is a no-op. Both return `{url}` with the canonical URL.

## Storage

`orb_links(orb_id, url, added_at)`, primary key `(orb_id, url)`, cascading with the orb row. Only URLs are stored; titles and status are always read live. Archival keeps links (`docs/teardown.md`).

## Status

`GET /api/v1/orbs/:orbId/links` returns `{repository, githubError, items: [{url, addedAt, github}]}`, oldest first. `repository` is the project's own `owner/repo`; refs to it render bare (`#291`, `run 1187`), others with the repository name (`determined#14`).

The control plane reads all links in one GitHub GraphQL request (`resource(url:)` per link) with the project owner's brokered GitHub token (`docs/credentials.md`), no cache. `github` carries the title, a status word and each check's result (`passed`, `failed`, `running`, `pending`); it is null for a link GitHub cannot resolve. When no status can be read at all (no GitHub login, token or request failure), every `github` is null and `githubError` names the reason. The browser polls every 15 s, not at the 2 s hosted-files cadence, to stay well inside GitHub's GraphQL rate limit.

## Drawer

In the header stack between the subagent rails and Files (`docs/web-ui.md`), hidden without links. Summary: `links` and one dot per link, right-aligned, showing its worst check (red failed, blinking green running/pending, black passed, gray without checks). Each row: ref (opens GitHub), title, one dot per check, status word. A row expands to the named checks and `remove`. Removal is immediate, with no undo: `DELETE /api/v1/orbs/:orbId/links?url=<url>` (204, idempotent). Design and rejected alternatives: `design-prototypes/orb-links.html`.

## Observability

`lifecycle:` edges `link-added` and `link-removed` with orb and URL, logged once per actual change. GitHub read failures are shown in the drawer, not logged: polling would turn a persistent failure into a level.

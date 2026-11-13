# Orb links

The agent registers GitHub pull requests, issues and Actions runs it is working on. The orb header shows them in a Links drawer with live GitHub status. Only the user removes a link.

## Registering

Central Pi calls the `orb_link({url})` tool; Claude runs `pi-orb link <github-url>`, which calls `PUT /runtime/v1/orb/links` with `{url}` and the runtime bearer (the CLI also works from central execution hosts). Both reach `addOrbLink` (`apps/control-plane/src/domain/orb-links.ts`). The shared environment prompt tells the agent to use its harness's tool whenever it opens a GitHub PR, issue or Actions run. The control plane accepts `https://github.com/<owner>/<repo>/{pull|issues|actions/runs}/<number>` and canonicalizes it (scheme, `www.`, trailing path, query and fragment dropped; `canonicalGithubLink` in `packages/protocol/src/orb-links.ts`). Saving an existing link is a no-op. Both return `{url}` with the canonical URL.

## Storage

`orb_links(orb_id, url, added_at)`, primary key `(orb_id, url)`, cascading with the orb row. Only URLs are stored; titles and status are always read live. Archival keeps links (`docs/teardown.md`).

## Status

`GET /api/v1/orbs/:orbId/links` returns `{repository, githubError, items: [{url, addedAt, github}]}`, oldest first. `repository` is the project's own `owner/repo`; refs to it render bare (`#291`, `1187` for a run), others with the repository name (`determined#14`, `determined 1187`).

The control plane reads all links in one GitHub GraphQL request (`resource(url:)` per link) with the project owner's brokered GitHub token (`docs/credentials.md`), no cache. `github` carries the title, a status word and each check's result (`passed`, `failed`, `running`, `pending`) https URL (`detailsUrl`, else the check-run page; a status's `targetUrl`), times (`startedAt`, `completedAt`; while a job is pending GitHub reports its ready time as `startedAt`, replaced by the real start once a runner picks it up) and job steps (up to 50, skipped ones dropped, each with result and times); commit statuses have no times or steps. `github` is null for a link GitHub cannot resolve. When no status can be read at all (no GitHub login, token or request failure), every `github` is null and `githubError` names the reason. The browser polls every 15 s, not at the 2 s hosted-files cadence, to stay well inside GitHub's GraphQL rate limit.

## Drawer

In the header stack (`docs/web-ui.md`), hidden without links; look: `docs/design-system.md`. The summary shows each link's worst check; hovering a dot shows its name and status. Each row: kind icon (pull request, issue, run) coloured by its status word, ref (opens GitHub), title, one dot per check, status word and a bin. Rows and summary dots order open or running links first, then closed (merged, closed, passed, failed); within each, pull requests, issues, runs, oldest first. The bin removes the link immediately, with no undo: `DELETE /api/v1/orbs/:orbId/links?url=<url>` (204, idempotent). A row expands to a CI waterfall of its checks, each name linking to its GitHub page (the Actions job for workflow checks). A runner wait is no longer known once the job starts (the REST jobs API's `created_at` would keep it, at one more request per workflow run). Clicking a check unfolds its job steps. Running bars advance with each poll.

## Observability

`lifecycle:` edges `link-added` and `link-removed` with orb and URL, logged once per actual change. GitHub read failures are shown in the drawer, not logged: polling would turn a persistent failure into a level.

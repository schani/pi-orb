# Orb links

The agent registers GitHub pull requests, issues and Actions runs it is working on. The orb header shows them in a Links drawer with live GitHub status. Only the user removes a link.

## Registering

Central Pi calls the `orb_link({url})` tool; Claude runs `pi-orb link <github-url>`, which calls `PUT /runtime/v1/orb/links` with `{url}` and the runtime bearer (the CLI also works from central execution hosts). Both reach `addOrbLink` (`apps/control-plane/src/domain/orb-links.ts`). The shared environment prompt tells the agent to use its harness's tool whenever it opens a GitHub PR, issue or Actions run. The control plane accepts `https://github.com/<owner>/<repo>/{pull|issues|actions/runs}/<number>` and canonicalizes it (scheme, `www.`, trailing path, query and fragment dropped; `canonicalGithubLink` in `packages/protocol/src/orb-links.ts`). Saving an existing link is a no-op. Both return `{url}` with the canonical URL.

## Storage

`orb_links(orb_id, url, added_at)`, primary key `(orb_id, url)`, cascading with the orb row. Only URLs are stored; titles and status are always read live. Archival keeps links (`docs/teardown.md`).

## Status

`GET /api/v1/orbs/:orbId/links` returns `{repository, githubError, items: [{url, addedAt, github}]}`, oldest first. `repository` is the project's own `owner/repo`; refs to it render bare (`#291`, `1187` for a run), others with the repository name (`determined#14`, `determined 1187`).

The control plane reads all links in one GitHub GraphQL request (`resource(url:)` per link) with the project owner's brokered GitHub token (`docs/credentials.md`), no cache. The query includes check summaries and scalar timings, not job steps. `github` carries the title, a status word, a pull request's added and deleted lines (`diff`), an issue's comment count (`comments`) and each check's GraphQL node `id`, result (`passed`, `failed`, `running`, `pending`), https URL (`detailsUrl`, else the check-run page; a status's `targetUrl`) and times (`startedAt`, `completedAt`; while pending, GitHub reports the job's ready time as `startedAt`, replaced by the real start once a runner picks it up). Commit statuses have null IDs and times.

`GET /api/v1/orbs/:orbId/links/steps?url=<registered-url>&checkId=<node-id>` returns `{steps, githubError}` for one expanded check, using a separate GraphQL node query. Each step has a name, result and epoch-ms times; at most 50 steps are read and skipped steps are dropped. Missing orbs or unregistered links return 404; invalid query parameters return 400. These browser reads never start compute.

GraphQL field errors and null check nodes or connections do not discard accessible status or checks. `github` is null for a link GitHub cannot resolve. `githubError` contains partial failures alongside usable data, or the reason no status could be read (login, token or request failure). Diagnostics include bounded, sanitized GitHub explanations and allowlisted request ID, rate-limit and retry headers, never credentials or raw payloads. The browser polls summaries every 15 s, not at the 2 s hosted-files cadence.

## Drawer

In the header stack (`docs/web-ui.md`), hidden without links; look: `docs/design-system.md`. The summary shows each link's worst check; hovering a dot shows its name and status. Each row: kind icon (pull request, issue, run) coloured by its status word, ref (opens GitHub), title, size (a pull request's line diff, an issue's comments, a run's time from its first check start to its last finish, or now), one dot per check, status word and a bin. Phones drop the status word; the icon colour carries it. Rows and summary dots order open or running links first, then closed (merged, closed, passed, failed); within each, pull requests, issues, runs, oldest first. The bin removes the link immediately, with no undo: `DELETE /api/v1/orbs/:orbId/links?url=<url>` (204, idempotent). A row expands to a CI waterfall of its checks, each name linking to its GitHub page (the Actions job for workflow checks). A runner wait is no longer known once the job starts (the REST jobs API's `created_at` would keep it, at one more request per workflow run). Clicking a check with an ID fetches and unfolds only that check's job steps; commit statuses cannot expand. Summary and expanded-check polls run 15 s after the previous response, never overlap within a poller, and pause in hidden tabs. Collapsing a check, link or drawer stops its step polling; changing orbs clears the drawer state and discards late responses. Running bars advance with each summary poll.

## Observability

`lifecycle:` edges `link-added` and `link-removed` carry the orb and URL. GitHub read failures are visible in the drawer and produce `github-links-failed` on a new failure reason, then `github-links-recovered` when it clears. Edges include the orb, operation (`status` or `steps`), expanded-check URL/ID when applicable, and sanitized diagnostics. A route-local map holds only failed operation fingerprints; request IDs, quota values and numeric counts do not change a fingerprint. Recovery deletes the entry. Repeated failures and healthy polls log nothing; process restarts reset deduplication.

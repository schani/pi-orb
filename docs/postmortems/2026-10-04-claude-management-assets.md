# Blank dashboard during local Claude-management publication (2026-10-04)

The frontend separation passed 496 web unit tests, 30 affected Chromium/WebKit cases and typecheck. Publishing its build to the running local service then produced a blank dashboard. The live browser could not find Claude after a 25-second wait; no success was reported to the user.

## Cause and evidence

The completed `web-dist-management` build was copied into the running service's `web-dist-current`: new hashed assets were appended, then the index was atomically replaced. This preserved old files but not a coherent serving contract.

`apps/control-plane/src/http/web-assets.ts:11` registers `@fastify/static` with `wildcard: false`. `apps/control-plane/src/main.ts:691–692` calls it once at startup using `PI_ORB_WEB_DIST`. The plugin enumerates files and registers individual GET/HEAD routes then; adding files later does not register new routes. Existing route contents, including the index, are still read from disk.

Live probes established:

| Resource | Before process refresh | After |
| --- | --- | --- |
| Index | 200, referencing new assets | 200 |
| `assets/index-UgL32MAP.js` | 404 despite file presence | 200 |
| `assets/index-D5CwItrC.css` | 404 despite file presence | 200 |
| Previous JS/CSS assets | 200 | Not needed for recovery |

This repeated the documented failure in `docs/postmortems/2026-09-09-live-web-rebuild.md`. Atomic index replacement does not update the startup route inventory; browser-cache invalidation cannot fix it.

## Recovery

Read-only checks confirmed the retained Claude connection was connected, the orb was stopped, and no runtime work or authorization ceremony was active. The parent gracefully drained the control plane and restarted it against the completed `web-dist-management` root, retaining database and authentication directories. Both new entry assets returned 200, and a real browser rendered Claude beside the dashboard gear. No credential mutation, inference or production deployment occurred.

## Invariant

Keep a served build root immutable. Build into a separate, nonserved directory; consider active process-hosted runtimes and authorization helpers before draining and refreshing the whole control-plane process against that completed root. Retain the database/authentication directories.

An index HTTP 200 is not readiness: require every referenced entry JS/CSS asset to return 200 with the expected MIME type, then verify the intended UI in a real browser. Do not add dynamic route machinery to conceal a publication error.

UI qualification evidence: `.context/claude-management-ui/{all-web,final-browser,unit,typecheck}.log`. These tests qualify source behavior, not the failed live publication.

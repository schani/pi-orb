# Blank dashboard after rebuilding a live static web root (2026-09-09)

The local process-provider service served a blank dashboard immediately after a frontend fix was rebuilt in place. Firefox reported a disallowed `text/html` MIME type for `/assets/index-DbQt_LnD.js` and `NS_ERROR_CORRUPTED_CONTENT`.

## Cause and evidence

`registerWebAssets` uses `@fastify/static` with `wildcard: false`: file routes are enumerated at startup, while their contents are read from disk. Rebuilding `apps/web/dist` replaced the index with references to new hashed assets. The running server served that new index but had no route for the new JavaScript filename. An HTTP probe confirmed **404 text/html**, containing the resource-not-found page, for the index's module URL. This was not browser-cache corruption.

The agent had verified only the index's HTTP 200 after rebuilding, then incorrectly told the user to refresh. That check did not prove that the application could load.

## Recovery

Checked project/orb state and processes first: the only local orb was waiting for device login; no process-hosted runtime was running. Restarted the control plane against the same persistent database/auth directories so it registered the current asset set. Graceful shutdown closed the listener but did not promptly exit, requiring forced termination before starting the replacement (investigation tracked in `TODO.md`). No competing database owner was started.

After restart, both referenced JS/CSS assets returned 200 with JavaScript/CSS MIME types, and a real browser rendered the existing project and orb.

## Resulting invariant

A running static service's build directory is immutable. For iterative frontend work use Vite; for built-UI updates start a service against the completed build, planning around any active process-hosted orbs. Do not change to unrestricted wildcard serving merely to hide this operational mistake.

A successful index response is insufficient validation: fetch its referenced assets, verify their status/MIME types, and verify actual browser rendering before claiming the UI works.

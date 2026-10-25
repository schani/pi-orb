# Codex fixture grant expiry

[CI 40198723431, job 121185111470](https://github.com/schani/pi-orb/actions/runs/40198723431/job/121185111470)
on `7e94bac4` failed the WebSocket-to-SSE diagnostics contract: the final SSE 401
omitted the expected broker generation. The other 5,467 tests passed.

The WebSocket fixture reused one bearer and generation but recalculated its expiry
from `Date.now()` on every broker lookup. Initialization and request authentication
could therefore disagree. `createDurableModels` correctly suppresses conflicting
same-bearer metadata rather than attributing a delayed request to an ambiguous grant.

Before correction, advancing `Date.now()` on every read reproduced the exact missing
generation assertion deterministically. The fixture now returns one stable grant;
the advancing-clock regression and all 17 diagnostics contracts pass. Production
logic, assertions, retries and deadlines are unchanged.

Original log, downloaded artifact inventory and contents, SHA-256 manifest, RED source
and RED/GREEN logs remain in `/workspace/ci/.context/ci-second-failure/`. This was not
a DST failure; the artifact's 19 JSON traces match tracked historical traces, with no
new failing schedule. No waiver or workflow rerun was used.

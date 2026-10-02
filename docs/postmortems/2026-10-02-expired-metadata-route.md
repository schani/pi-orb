# Expired metadata intercepted as JSON (2026-10-02)

The first complete process E2E passed 180 assertions but exited with an unhandled `Unexpected token '<'` rejection. The lifecycle-banner browser test intercepted orb metadata and parsed every forwarded response as JSON. Expiring the shared frontend fixture session returned HTML 401 to an in-flight metadata poll; the route handler rejected outside the test assertion. Its teardown restored the shared session without draining routes. Evidence: `.context/path-routing/full-e2e-process.log`.

A request/response-gated metadata GET after expiry reproduced the HTML parse rejection on desktop and phone (`.context/path-routing/expired-metadata-red.log`). The interceptor now changes only successful JSON metadata and forwards other responses unchanged. The test asserts the gated request returns 401, then drains its routes before restoring shared session state and closing its page. Both targeted cases, the 120-case frontend suite, and the complete process E2E (180 passed, two backend-specific skips, no unhandled errors) pass. The process backend does not validate Docker/PostgreSQL or deployed IAP.

Rule: browser interception must preserve non-matching response contracts and complete owned handlers before shared fixture teardown. `docs/testing.md` records the test boundary.

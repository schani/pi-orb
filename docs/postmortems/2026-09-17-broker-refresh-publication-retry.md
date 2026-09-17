# Broker refresh publication stopped after a proved pre-commit failure

**Date:** 2026-09-17  
**Status:** fixed locally; deployment remained blocked pending qualification

## Impact

A transient pointer-store failure after upstream refresh could leave the canonical pointer on the consumed refresh token. A later refresh then received `invalid_grant`, cleared the pointer, and required login.

## Evidence

The full test suite failed iteration 19 of `broker-failpoint-storm`; the first trace is preserved at `test-failures/broker-failpoint-storm-1789686775181-19.json`. Pre-change replay reproduced the `auth_required` outcome.

The trace shows runtime 4 rotate upstream and write secret `v2`. The `broker.pointer.write.before` failpoint then refused its publication CAS. An exact reread still found runtime 4's leased row, proving the CAS had not landed and no competitor had moved the pointer. The broker nevertheless returned `credential commit uncertain`. After lease expiry, runtime 0 refreshed with the old consumed token, received `invalid_grant`, and cleared the pointer.

## Root cause

This was a product bug, not an invalid scenario. `docs/credentials.md` required the refresh write path to retry within its lease, but `getToken` retried secret writes only. It used a reread solely to recognize a landed pointer CAS and discarded the equally conclusive unchanged-lease result.

## Fix and regression

Refresh publication now always makes its first fenced CAS, even if scheduling advanced past the lease while upstream was in flight. After an error or conflict it rereads. The staged version means publication landed; the same generation and old secret mean only lease state changed, so publication retries at that exact row-version fence within the request deadline. A newer generation or different secret wins and cannot be overwritten.

The first validation run exposed that distinction in `test-failures/broker-abandoned-lease-1789687325141-8.json`: suppressing the first CAS merely because virtual time had crossed the lease produced `credential commit uncertain`, despite no competing pointer mutation. Pre-change replay reproduced it. The row-version CAS, not elapsed time alone, safely fences that first publication attempt.

Independent review found that treating every publication conflict as a newer credential was also unsafe: after lease expiry, a second refresher could acquire only a replacement lease over the consumed old secret. Destroying the staged fresh secret then made its `invalid_grant` clear the pointer. The reproduced trace is `test-failures/broker-refresh-replacement-lease-1789687881255-0.json`.

`broker-refresh-publication-retry` injects a pre-commit failure. `broker-refresh-replacement-lease` forces two actors across lease expiry and proves the staged refresh publishes at the replacement row-version fence; the second actor then observes generation 2. The scenario disables late-timer exploration because it tests ordinary lease takeover, not request-deadline failure. The original storm remains unchanged.

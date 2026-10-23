# Google signed-out login 500

2026-10-23 PDT

- User reported immediate Google `/samlredirect` 500 before email entry in signed-out Safari and Chrome.
- In affected Chrome, the same OAuth continuation with only `hd` removed restored the initial sign-in screen; full login, Safari recovery and underlying cause remain unqualified.
- Clean-browser requests with the original `hd` reached Google's sign-in screen; the natural failure did not reproduce.
- Direct `/samlredirect` navigation returned 500, not a full-flow reproduction; no failed application callbacks were attributable to the incident.
- Decision: omit the [optional request hint](https://developers.google.com/identity/openid-connect/openid-connect#hd); signed `hd=heyglide.com` admission, verified email, issuer, audience, expiry, state, nonce and PKCE remain unchanged.
- Local validation: test-first URL contract red→green; focused suite 17 passed; signed OIDC contracts 11 passed, including wrong/missing `hd`; control-plane typecheck and repository lint passed (existing warnings).
- No full E2E or deployment performed.

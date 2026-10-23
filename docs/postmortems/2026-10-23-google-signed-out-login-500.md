# Google signed-out login: reported 500

## Status — 2026-10-23, PDT

The user reports Google's branded 500 immediately after Sign in, before email
entry, in signed-out Safari and Chrome. The failing path is
`accounts.google.com/samlredirect`, with an inbound SAML SSO profile and a
nested OAuth continuation. Removing outbound `hd` restores Chrome's initial
sign-in page. The change is local, not deployed; the underlying SAML failure,
Safari recovery and full interactive login remain unqualified.

## Evidence and scope

- The continuation uses our standard `/o/oauth2/v2/auth` request with
  `hd=heyglide.com` and `authuser=unknown`. Our code emitted `hd`, not
  `authuser`, `sso_profile` or `/samlredirect`.
- In the affected Chrome context, the user opened the same OAuth continuation
  with only `hd` removed; state, nonce, PKCE, callback and `authuser` stayed
  unchanged. Google's regular sign-in screen appeared. This establishes an
  initial-page workaround only, not full login or account-level SSO bypass.
- Clean Chromium app/files login requests reached Google's identifier page.
  Clean OAuth requests both with and without `hd` also reached that page;
  neither reproduced the user's automatic SAML routing.
- Manually navigating to `/samlredirect` with the supplied SSO profile and a
  fresh continuation reproduced Google's 500 for that constructed request,
  not the user's full natural redirect path. The routing cause is unproven.
- Cloud Logging at 15:12 PDT, preceding 24 hours, returned 14 events: 11 login
  starts, three accepted callbacks, zero failed callbacks. None can be linked
  to the user's failure. Probes at 15:09:32 and 15:11:51 PDT had no callback.
- Fake-provider E2Es do not qualify Google's real sign-in or interactive login.
- Google's [domain-routing](https://support.google.com/a/answer/6369487?hl=en) and [SSO-assignment](https://support.google.com/a/answer/12032922?hl=en) docs do not establish this request's routing cause.

## Admission and observability

Google's [OIDC documentation](https://developers.google.com/identity/openid-connect/openid-connect#hd)
defines request `hd` as an optional UI optimization, not access control.
Removing it does not relax admission: signed `hd=heyglide.com`, verified email,
issuer, client audience and expiry remain required; PKCE, state and nonce are
unchanged. See `docs/credentials.md`. Existing sanitized login/callback events
cover application outcomes, not upstream pages before callback. No new
persistence or OAuth URL logging is added.

## Local validation and evidence

After `npm ci`, the URL contract failed before removal (`hd` present: one
failed, four passed); all five passed after removal. URL checks cover issuer,
path, client, callback, scope, response type, state, nonce and PKCE. Focused
adapter/domain/DST/HTTP/composition tests passed (17 tests, six files), as did
control-plane typecheck and repository lint (existing warnings). Signed OIDC
contracts passed (11 tests), including wrong/missing `hd` rejection despite a
verified `heyglide.com` email. Logs: `/tmp/pi-orb-auth-{red,green,focused,typecheck,lint,signed}.log`.
Temporary source evidence: `/tmp/pi-orb-login-events.json` and sensitive
`/tmp/pi-orb-auth-headers.txt`; never copy raw headers, cookies or OAuth URLs.
No full E2E, deployment or full real-Google login was performed. Actions live
only in `TODO.md`.

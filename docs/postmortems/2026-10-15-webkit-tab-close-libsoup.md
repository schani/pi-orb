# WebKit network process corrupted by closing a loading tab

2026-10-15. `e2e/usage-frontend.e2e.test.ts` (WebKit) timed out after navigations on CI: [#116 E2E](https://github.com/schani/pi-orb/actions/runs/38758911470/job/116504644995), [#116 Central process](https://github.com/schani/pi-orb/actions/runs/38773552758/job/116555287000), [#120 E2E](https://github.com/schani/pi-orb/actions/runs/38778619033/job/116572660333). It never reproduced locally (27 runs).

Instrumented CI loops (64 WebKit runs each) on Playwright WebKit 2359, ubuntu-24.04:

| Run | Variant | Failed |
| --- | --- | --- |
| [38803000506](https://github.com/schani/pi-orb/actions/runs/38803000506) | request/route tracking | 12 |
| [38803006081](https://github.com/schani/pi-orb/actions/runs/38803006081) | release every held usage request | 9 |
| [38804515111](https://github.com/schani/pi-orb/actions/runs/38804515111) | `DEBUG=pw:browser` | 9 |
| [38805389607](https://github.com/schani/pi-orb/actions/runs/38805389607) | wait for `networkidle` before `tab.close()` | 0 |

Every failure left the same seven requests pending, including a static favicon, after ~20 navigations. No earlier request or WebSocket remained open. With browser logs, 5 of 9 failures show the network process asserting `g_atomic_rc_box_release_full: assertion 'real_box->magic == G_BOX_MAGIC'`, then `soup_session_feature_request_queued` on invalid objects for every later request. Each assertion follows a modifier-click tab's creation by 61–96 ms; the test closed that tab once its URL matched, mid-load. One passing run recovered when WebKit reported "Network process crashed" 28 s later.

Cause: a libsoup use-after-free in WebKit's network process, triggered by closing a tab with loads in flight. Not a pi-orb defect. Rule: tests close a WebKit tab only after its network is idle.

Rejected as causes: mock-backend load, leaked Vite WebSockets, the usage test's lost second held-request resolver (fixing it left 9/64 failures), and navigation timing (the `goBack` waits alone did not prevent it).

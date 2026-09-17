# Terminal shade E2E accepted a stale `scrollend`

**Date:** 2026-09-16. **Classification:** test synchronization defect. No product code changed.

## Symptom

`e2e/frontend-session.e2e.test.ts`, `toggles a headerless terminal shade without
moving history or replacing its session`, failed intermittently on the
`transcript-model` branch (commit `6d207c6`):

```text
expect(received).toBeLessThan(expected)
Expected: < 400
Received: 400
```

The assertion follows a `page.mouse.wheel(0, -53)` over `.wterm` and is gated on
a `data-scroll-ended` attribute set by a one-shot `scrollend` listener. It
reproduced 1 in 6 unmodified runs and about 3% instrumented on that branch, and
0 in 25 on `origin/main`: latent on main, surfaced by a schedule shift.

## Measured schedule

`.wterm` was pinned at the bottom before the wheel: `scrollTop` 400,
`clientHeight` 240, `scrollHeight` 640. In the failing schedule:

```text
+0.0 ms   one-shot scrollend listener attached, scrollStart sampled as 400
+0.2 ms   queued scroll notification delivered, scrollTop still 400
          (from the follow-tail write, or the mandatory re-snap after the
           30 scrollback rows were inserted)
+~0 ms    Chromium fires scrollend for that notification
          the one-shot listener consumes it and sets data-scroll-ended=true
+~0 ms    test reads scrollTop: 400 — assertion fails
+~80 ms   the wheel's real scroll arrives, scrollTop settles at 347
```

Instrumentation intercepted no `scrollTop` writes by the product, and
`@wterm/dom` installs no wheel listeners: the terminal never re-pinned. The
offset was simply read before the wheel had moved anything.

## Why the gate accepted it

The gate conflated "a scroll ended" with "my scroll ended". `scrollend` carries
no identity, so a one-shot listener latches whichever settle arrives first,
including one belonging to a scroll that was already queued when the listener
attached and that leaves the offset unchanged. Sampling `scrollStart` in the
same evaluation did not help: the baseline was correct, but the gate released
before the wheel produced movement away from it.

## Fix

Two changes in the test, both in `e2e/frontend-session.e2e.test.ts`:

- **Quiescence before sampling.** `scrollStart` is read only after two
  consecutive animation frames with no `scroll` event on `.wterm`, so the
  earlier terminal writes have drained.
- **A gate that requires observed movement.** The one-shot `scrollend` listener
  is replaced by a persistent pair: a `scroll` listener that marks the node only
  when `scrollTop !== scrollStart`, and a `scrollend` listener that sets
  `data-scroll-ended` only when that mark is present. Stale settles are ignored
  instead of consuming the gate.

The `scrollend` gate itself stays: the row-edge check that follows needs the
snap to settle (~270 ms). The assertion is unchanged and no timeout was raised.

## Verification

The natural schedule did not reproduce on the fixing machine: 48 unmodified runs
of the unfixed test on `transcript-model` (`6d207c6`) all passed, so a statistical
run there proves nothing. The gate was therefore tested directly. A temporary
probe dispatched a synthetic `scroll` followed by `scrollend` on `.wterm`
immediately after the gate was installed and before the wheel — exactly the
stale notification of the measured schedule, with the offset unchanged.

Against the unfixed gate the probe reproduced the reported failure
deterministically:

```text
× toggles a headerless terminal shade without moving history or replacing its session
  → expect(received).toBeLessThan(expected)

Expected: < 400
Received:   400
```

Against the fixed gate the same probe passed 10 of 10: the stale settle is
ignored and the gate releases on the wheel's own scroll.

| Worktree | Branch | Test | Runs | Result |
| --- | --- | --- | --- | --- |
| `.context/shade-verify` | `transcript-model` (`6d207c6`) | unfixed, unmodified | 48 | 48 pass (no natural repro on this machine) |
| `.context/shade-verify` | `transcript-model` (`6d207c6`) | unfixed + stale-settle probe | 1 | fail, signature above |
| `.context/shade-verify` | `transcript-model` (`6d207c6`) | fixed + stale-settle probe | 10 | 10 pass |
| `.context/shade-verify` | `transcript-model` (`6d207c6`) | fixed | 60 | 60 pass |
| `.context/shade-fix` | `fix/terminal-shade-scrollend` | fixed | 10 | 10 pass |

The probe is evidence, not committed code: it asserts the gate's logic, which the
committed test exercises against the browser's own events.

## Rule

A settle gate must require observed movement caused by its own trigger. Never
accept a bare `scrollend`, `transitionend`, or `animationend`: arm the gate with
a state change away from a baseline sampled after quiescence, and only then
allow the settle event to release it.

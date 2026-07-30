# `determined` bug: awaiting another task's promise deadlocks the simulation

## Summary

When simulation task B `await`s a promise that will be settled by
simulation task A's timer, the scheduler stops firing timers entirely.
The pending timer that would settle the promise never fires, `runTasks`
never resolves, and the process hangs (Node reports an unsettled
top-level await and exits with code 13). There is no error, no deadlock
diagnostic, and no trace entry pointing at the blocked task.

Cross-task promise sharing is a natural thing to write — any
singleflight/coalescing helper produces exactly this shape — and the
failure mode is a silent hang, which is the worst possible outcome in a
deterministic-testing framework.

- `determined`: 0.4.0
- Node: v24.6.0

## Repro

```js
// repro.mjs — run with: node repro.mjs
import {
  RecordingTraceSource,
  SimpleEntropySource,
  SimulationImpl,
} from "determined";

const sim = new SimulationImpl(
  { log: (...a) => console.log(...a), error: console.error },
  new RecordingTraceSource(new SimpleEntropySource()),
  () => 0,
  { wallClockEpoch: 0, maxSchedulingSteps: 10_000, maxVirtualDurationMs: 60_000 },
);

let shared = null;

const result = await sim.runTasks([
  {
    name: "owner",
    f: async (task) => {
      shared = task.sleep(10, "work").then(() => "done");
      await shared;
      console.log("owner finished");
    },
  },
  {
    name: "waiter",
    f: async (task) => {
      // Wait until the owner has published its promise, then await it.
      while (shared === null) await task.sleep(1, "poll");
      await shared; // <-- deadlock: settled by the owner's timer
      console.log("waiter finished");
    },
  },
]);
console.log("runTasks:", result.isOk() ? "ok" : result.error.message);
```

## Observed

```text
owner CHECKPOINT: START
waiter CHECKPOINT: START
waiter UNBLOCKED at t=0ms from owner, waiter
waiter SLEEP 'poll' at t=0ms for 1ms until t=1ms
TIMER 'waiter sleep: poll' created at t=0ms with deadline t=1ms
owner UNBLOCKED at t=0ms from owner, waiter
owner SLEEP 'work' at t=0ms for 10ms until t=10ms
TIMER 'owner sleep: work' created at t=0ms with deadline t=10ms
TIMER 'waiter sleep: poll' fired at t=1ms (deadline t=1ms)
waiter UNBLOCKED at t=1ms from owner, waiter
Warning: Detected unsettled top-level await at file:///…/repro.mjs:16
```

Node then exits with code 13. Note the state at the hang: the timer
`'owner sleep: work'` (deadline t=10ms) is still pending — firing it
would settle `shared` and let both tasks finish — but after the waiter
resumes at t=1ms and awaits the foreign promise, no timer ever fires
again.

## Analysis

After a task resumes, the scheduler appears to wait for it to reach a
blocking point it recognizes (a `task.sleep`, checkpoint, etc.) before
advancing virtual time. Awaiting a promise the scheduler cannot
attribute to the awaiting task does not count as such a point, so the
scheduler considers the waiter "still running" forever and never
advances time to the owner's timer — even though no JavaScript is
runnable and a pending timer exists.

## Expected

One of, in order of preference:

1. **Make it work**: when the microtask queue drains and no task is
   runnable, advance virtual time to the next pending timer even if some
   tasks are blocked on unattributed promises. That would make
   cross-task promise sharing (singleflight, coalescing, `Promise.all`
   across tasks) just work.
2. **Fail loudly**: detect the state "no runnable task, pending timers
   exist, at least one task blocked outside a recognized wait" and abort
   the simulation with a diagnostic naming the blocked task(s). A
   deterministic framework should never hang silently.

## Workaround

Never hand one task's promise to another task. Share a plain mutable
record and let waiters poll it on their own timers:

```js
// instead of: return inFlightPromise;
while (!flight.settled) await task.sleep(25, "await in-flight fetch");
return flight.outcome;
```

This is what pi-orb's broker token client does
(`apps/orb-runtime/src/domain/broker-client.ts`); with polling, the same
scenario passes.

## Context

Found while implementing singleflight in pi-orb's runtime broker client:
the DST for "concurrent fetches share one in-flight request" hung the
vitest worker (30 s test timeout) instead of failing with any useful
signal.

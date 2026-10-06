import { expect, test } from "vitest";
import { runDst, waitUntil } from "../../control-plane/src/testkit/sim.ts";
import { awaitInitialCheckoutCommit } from "./pending-initial-checkout.ts";

const broker = { controlPlaneUrl: "http://cp", runtimeToken: "private" };
const environment = { PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT: "1" };
test("Stop wins pending pin acquisition without late checkout authority (DST)", async () => {
  await runDst({ name: "pending-pin-stop", iterations: 20 }, async (sim) => {
    const abort = new AbortController();
    let requested = false;
    const result = await sim.runTasks([
      {
        name: "poll",
        f: async (task) => {
          const pin = await awaitInitialCheckoutCommit(environment, broker, "7", {
            signal: abort.signal,
            now: () => task.monotonicNow(),
            checkpoint: (name) => task.checkpoint(name),
            sleep: (ms) => task.sleep(ms, "pin pending"),
            fetch: async () => {
              requested = true;
              return Response.json({ pending: true }, { status: 202 });
            },
          });
          expect(pin.isErr()).toBe(true);
          if (pin.isErr()) expect(pin.error.code).toBe("checkout_cancelled");
        },
      },
      {
        name: "stop",
        f: async (task) => {
          await waitUntil(task, "pin requested", () => requested);
          abort.abort();
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
test("pending pin polls with immutable bearer/incarnation and injected scheduling", async () => {
  let calls = 0,
    now = 0;
  const checkpoints: string[] = [];
  const result = await awaitInitialCheckoutCommit(environment, broker, "7", {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    checkpoint: async (name) => {
      checkpoints.push(name);
    },
    fetch: async (url, init) => {
      expect(url).toBe("http://cp/api/runtime/initial-checkout");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private");
      expect(new Headers(init?.headers).get("x-orb-incarnation")).toBe("7");
      return ++calls === 1
        ? Response.json({ pending: true }, { status: 202 })
        : Response.json({ commitSha: "a".repeat(40) });
    },
  });
  expect(result._unsafeUnwrap()).toBe("a".repeat(40));
  expect(calls).toBe(2);
  expect(checkpoints).toHaveLength(2);
});
test("waits for launch bearer attachment but fails a revoked already-admitted runtime", async () => {
  let now = 0;
  const responses = [
    Response.json({ error: "unauthorized" }, { status: 401 }),
    Response.json({ pending: true }, { status: 202 }),
    Response.json({ commitSha: "a".repeat(40) }),
  ];
  const ready = await awaitInitialCheckoutCommit(environment, broker, "7", {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async () => responses.shift()!,
  });
  expect(ready._unsafeUnwrap()).toBe("a".repeat(40));
  const revoked = [
    Response.json({ pending: true }, { status: 202 }),
    Response.json({ error: "unauthorized" }, { status: 401 }),
  ];
  let sleeps = 0;
  const stopped = await awaitInitialCheckoutCommit(environment, broker, "7", {
    now: () => now,
    sleep: async (ms) => {
      sleeps++;
      now += ms;
    },
    fetch: async () => revoked.shift()!,
  });
  expect(stopped.isErr()).toBe(true);
  if (stopped.isErr()) expect(stopped.error.code).toBe("checkout_admission_revoked");
  expect(sleeps).toBe(1);
});
test.each([409, 403, 503])("terminal pin response %i never waits forever", async (status) => {
  let sleeps = 0;
  const result = await awaitInitialCheckoutCommit(environment, broker, "7", {
    fetch: async () =>
      Response.json(
        { error: status === 503 ? "resource_acquisition_failed" : "checkout_admission_revoked" },
        { status },
      ),
    sleep: async () => {
      sleeps++;
    },
  });
  expect(result.isErr()).toBe(true);
  expect(sleeps).toBe(0);
});
test("outage wait is bounded and cancellation prevents late fetch", async () => {
  let now = 0,
    calls = 0;
  const result = await awaitInitialCheckoutCommit(environment, broker, "7", {
    timeoutMs: 20,
    now: () => now,
    sleep: async () => {
      now += 10;
    },
    fetch: async () => {
      calls++;
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
  });
  expect(result.isErr()).toBe(true);
  expect(calls).toBe(2);
  const abort = new AbortController();
  abort.abort();
  const cancelled = await awaitInitialCheckoutCommit(environment, broker, "7", {
    signal: abort.signal,
    fetch: async () => {
      throw new Error("late fetch");
    },
  });
  expect(cancelled.isErr()).toBe(true);
});
test("known pin and host-pi do not request the endpoint", async () => {
  const fetch = async () => {
    throw new Error("unexpected fetch");
  };
  expect(
    (await awaitInitialCheckoutCommit({}, null, "1", { fetch }))._unsafeUnwrap(),
  ).toBeUndefined();
  expect(
    (
      await awaitInitialCheckoutCommit(
        { ...environment, PI_ORB_INITIAL_CHECKOUT_COMMIT: "b".repeat(40) },
        broker,
        "1",
        { fetch },
      )
    )._unsafeUnwrap(),
  ).toBe("b".repeat(40));
});

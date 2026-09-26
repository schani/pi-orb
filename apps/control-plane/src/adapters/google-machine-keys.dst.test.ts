import { err, ok, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { GoogleMachineKeys } from "./google-machine-keys.ts";

it("singleflight and unknown-key cooldown bound concurrent provider work", async () => {
  await runDst({ name: "google-machine-key-singleflight", iterations: 20 }, async (sim) => {
    let requests = 0;
    let now = 0;
    const keys = new GoogleMachineKeys(
      (task) =>
        ResultAsync.fromSafePromise(
          (async () => {
            requests++;
            await task.checkpoint("google-keys:fetch");
            return { keys: { known: "certificate" }, maxAgeMs: 60_000 };
          })(),
        ),
      () => now,
    );
    const result = await sim.runTasks(
      [0, 1, 2].map((n) => ({
        name: `verify-${n}`,
        f: async (task) => {
          expect((await keys.get(task, "known")).isOk()).toBe(true);
          expect((await keys.get(task, `unknown-${n}`)).isOk()).toBe(true);
        },
      })),
    );
    expect(result.isOk()).toBe(true);
    expect(requests).toBeLessThanOrEqual(2);
    now = 1000;
    const second = await sim.runTasks([
      {
        name: "more-unknown",
        f: async (task) => {
          for (let i = 0; i < 10; i++) await keys.get(task, `random-${i}`);
        },
      },
    ]);
    expect(second.isOk()).toBe(true);
    expect(requests).toBeLessThanOrEqual(2);
    expect(requests).toBe(1);
  });
});

it("outage cooldown prevents retries and recovers after its deadline", async () => {
  await runDst({ name: "google-machine-key-outage", iterations: 20 }, async (sim) => {
    let requests = 0;
    let now = 0;
    let offline = true;
    const keys = new GoogleMachineKeys(
      (task) =>
        ResultAsync.fromSafePromise(
          (async () => {
            requests++;
            await task.checkpoint("google-keys:outage");
            return offline
              ? err({ type: "identity_unavailable" as const, message: "Google unavailable" })
              : ok({ keys: { known: "cert" }, maxAgeMs: 60_000 });
          })(),
        ).andThen((result) => result),
      () => now,
    );
    const result = await sim.runTasks(
      [0, 1, 2].map((n) => ({
        name: `outage-${n}`,
        f: async (task) => {
          expect((await keys.get(task, "known")).isErr()).toBe(true);
          expect((await keys.get(task, "unknown")).isErr()).toBe(true);
        },
      })),
    );
    expect(result.isOk()).toBe(true);
    expect(requests).toBe(1);
    offline = false;
    now = 30_000;
    const recovered = await sim.runTasks([
      {
        name: "recovery",
        f: async (task) => {
          expect((await keys.get(task, "known")).isOk()).toBe(true);
        },
      },
    ]);
    expect(recovered.isOk()).toBe(true);
    expect(requests).toBe(2);
  });
});

it("fresh known keys bypass an unknown-key refresh even when it fails", async () => {
  await runDst({ name: "google-known-key-refresh-isolation", iterations: 20 }, async (sim) => {
    let now = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const keys = new GoogleMachineKeys(
      (task) => {
        requests++;
        if (requests === 1)
          return ResultAsync.fromSafePromise(
            Promise.resolve({ keys: { known: "cert" }, maxAgeMs: 60_000 }),
          );
        return ResultAsync.fromSafePromise(
          (async () => {
            await task.checkpoint("unknown-refresh:held");
            await held;
            return err({ type: "identity_unavailable" as const, message: "offline" });
          })(),
        ).andThen((result) => result);
      },
      () => now,
    );
    const result = await sim.runTasks([
      {
        name: "forced-interleaving",
        f: async (task) => {
          expect((await keys.get(task, "known")).isOk()).toBe(true);
          now = 30_000;
          const refresh = keys.get(task, "unknown");
          let knownSucceeded = false;
          const known = keys.get(task, "known").then((result) => {
            knownSucceeded = result.isOk();
          });
          await task.checkpoint("known-key:must-not-wait");
          const succeededBeforeRelease = knownSucceeded;
          release();
          await known;
          expect((await refresh).isErr()).toBe(true);
          expect(succeededBeforeRelease).toBe(true);
          expect(knownSucceeded).toBe(true);
          expect(requests).toBe(2);
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
  });
});

it("emits only outage and recovery edges across repeated failures", async () => {
  await runDst({ name: "google-key-provider-edges", iterations: 20 }, async (sim) => {
    let now = 0;
    let offline = false;
    const outcomes: unknown[] = [];
    const keys = new GoogleMachineKeys(
      () =>
        ResultAsync.fromSafePromise(
          Promise.resolve(
            offline
              ? err({ type: "identity_unavailable" as const, message: "secret" })
              : ok({ keys: { known: "cert" }, maxAgeMs: 0 }),
          ),
        ).andThen((result) => result),
      () => now,
      (outcome) => outcomes.push(outcome),
    );
    const result = await sim.runTasks([
      {
        name: "edges",
        f: async (task) => {
          await keys.get(task, "known");
          expect(outcomes).toEqual([]);
          offline = true;
          for (let i = 0; i < 3; i++) {
            now += 30_000;
            expect((await keys.get(task, "known")).isErr()).toBe(true);
            await keys.get(task, "known");
          }
          expect(outcomes).toEqual([{ type: "google_key_provider_outage" }]);
          offline = false;
          for (let i = 0; i < 3; i++) {
            now += 30_000;
            await keys.get(task, "known");
          }
          expect(outcomes).toEqual([
            { type: "google_key_provider_outage" },
            { type: "google_key_provider_recovered" },
          ]);
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
  });
});

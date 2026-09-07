import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeSigningKeyHarness } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import type { StoreError } from "./errors.ts";
import { ensureActiveSigningKey, SIGNING_KEY_SECRET_PROVIDER } from "./signing-keys.ts";

const outage: StoreError = {
  type: "store_error",
  code: "unavailable",
  message: "injected outage",
  retryable: true,
};

describe("signing-key bootstrap ownership across outer retries", () => {
  it("reuses the same material after insert/read failures and inner-loop exhaustion", async () => {
    await runDst({ name: "signing-key-outer-retry-ownership", iterations: 30 }, async (sim) => {
      const h = makeSigningKeyHarness();
      const list = h.keys.listSigningKeys.bind(h.keys);
      const insert = h.keys.insertSigningKey.bind(h.keys);
      let failInsert = true;
      let failReadAfterInsert = true;
      let nextReadFails = false;
      h.keys.listSigningKeys = (task) => {
        if (nextReadFails) {
          nextReadFails = false;
          return errAsync(outage);
        }
        return list(task);
      };
      h.keys.insertSigningKey = (task, row) => {
        if (!failInsert) return insert(task, row);
        nextReadFails = failReadAfterInsert;
        return errAsync(outage);
      };
      const run = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            for (let retry = 0; retry < 3; retry++) {
              await task.checkpoint("outer boot retry after insert then read failure");
              expect(
                (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
              ).toBe(true);
              expect(h.generator.generated).toBe(1);
              expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toEqual(["v1"]);
            }
            failReadAfterInsert = false;
            expect(
              (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
            ).toBe(true);
            expect(h.generator.generated).toBe(1);
            expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toEqual(["v1"]);
            failInsert = false;
            const established = await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() });
            expect(established.isOk()).toBe(true);
            expect(established._unsafeUnwrap().secretVersion).toBe("v1");
            expect(h.generator.generated).toBe(1);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });

  it("refuses overlapping attempts on one bootstrap owner without sharing mutable candidates", async () => {
    await runDst({ name: "signing-key-bootstrap-exclusive-owner", iterations: 30 }, async (sim) => {
      const h = makeSigningKeyHarness();
      const list = h.keys.listSigningKeys.bind(h.keys);
      let entrants = 0;
      let successes = 0;
      let busy = 0;
      h.keys.listSigningKeys = (task) =>
        ResultAsync.fromPromise(
          (async () => {
            while (entrants < 2)
              await task.checkpoint("hold first read until both ensure callers entered");
          })(),
          () => outage,
        ).andThen(() => list(task));
      const run = await sim.runTasks(
        [0, 1].map((index) => ({
          name: `caller-${index}`,
          f: async (task) => {
            entrants++;
            const result = await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() });
            if (result.isOk()) successes++;
            else {
              expect(result.error).toMatchObject({ code: "unavailable", retryable: true });
              busy++;
            }
          },
        })),
      );
      if (run.isErr()) throw run.error;
      expect(successes).toBe(1);
      expect(busy).toBe(1);
      expect(h.generator.generated).toBe(1);
      expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toHaveLength(1);
    });
  });

  it.each(["before", "after"])(
    "never publishes material after destruction failed %s commit, even if the active slot becomes empty",
    async (failure) => {
      await runDst(
        { name: `signing-key-cleanup-${failure}-commit`, iterations: 20 },
        async (sim) => {
          const h = makeSigningKeyHarness({ kidPrefix: "loser" });
          const winner = makeSigningKeyHarness({
            keys: h.keys,
            secrets: h.secrets,
            kidPrefix: "winner",
          });
          const insert = h.keys.insertSigningKey.bind(h.keys);
          let refuseInsert = true;
          h.keys.insertSigningKey = (task, row) =>
            refuseInsert && row.kid.startsWith("loser") ? errAsync(outage) : insert(task, row);
          const destroy = h.secrets.destroySecret.bind(h.secrets);
          let refuseCleanup = true;
          h.secrets.destroySecret = (task, provider, version) =>
            !refuseCleanup
              ? destroy(task, provider, version)
              : failure === "before"
                ? errAsync(outage)
                : destroy(task, provider, version).andThen(() => errAsync(outage));
          const run = await sim.runTasks([
            {
              name: "boot",
              f: async (task) => {
                expect(
                  (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
                ).toBe(true);
                const active = (
                  await ensureActiveSigningKey(task, winner.deps, { now: task.wallNow() })
                )._unsafeUnwrap();
                expect(
                  (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isOk(),
                ).toBe(true);
                expect(
                  (
                    await h.keys.casSigningKeyState(task, {
                      kid: active.kid,
                      expectedRowVersion: active.rowVersion,
                      state: "retired",
                      retiredAt: task.wallNow(),
                    })
                  ).isOk(),
                ).toBe(true);
                refuseInsert = false;
                await task.checkpoint("active slot emptied after ambiguous cleanup");
                expect(
                  (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
                ).toBe(true);
                expect(h.generator.generated).toBe(1);
                expect(h.keys.activeRows()).toEqual([]);
                refuseCleanup = false;
                const repaired = (
                  await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })
                )._unsafeUnwrap();
                expect(repaired.secretVersion).not.toBe("v1");
                expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toContain(
                  repaired.secretVersion,
                );
                expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toContain(
                  active.secretVersion,
                );
                expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).not.toContain("v1");
                expect(h.deps.bootstrap.generated).toBeNull();
              },
            },
          ]);
          if (run.isErr()) throw run.error;
        },
      );
    },
  );

  it("adopts its committed-but-unacknowledged row after the following read also failed", async () => {
    await runDst({ name: "signing-key-outer-retry-lost-ack", iterations: 20 }, async (sim) => {
      const h = makeSigningKeyHarness();
      const list = h.keys.listSigningKeys.bind(h.keys);
      const insert = h.keys.insertSigningKey.bind(h.keys);
      let nextReadFails = false;
      h.keys.listSigningKeys = (task) => {
        if (nextReadFails) {
          nextReadFails = false;
          return errAsync(outage);
        }
        return list(task);
      };
      h.keys.insertSigningKey = (task, row) =>
        insert(task, row).andThen(() => {
          nextReadFails = true;
          return errAsync(outage);
        });
      const run = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            expect(
              (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
            ).toBe(true);
            await task.checkpoint("retry after lost insert ack and failed read");
            const established = await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() });
            expect(established.isOk()).toBe(true);
            expect(h.generator.generated).toBe(1);
            expect(h.secrets.destroyedVersions()).toEqual([]);
            expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toEqual(["v1"]);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    });
  });

  it("retains failed cleanup for a later retry, logs its outcome, and never destroys referenced material", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "signing-key-outer-retry-cleanup", iterations: 20, logCapture: log },
      async (sim) => {
        const h = makeSigningKeyHarness({ kidPrefix: "loser" });
        const winner = makeSigningKeyHarness({
          keys: h.keys,
          secrets: h.secrets,
          kidPrefix: "winner",
        });
        const insert = h.keys.insertSigningKey.bind(h.keys);
        let refuseLoser = true;
        h.keys.insertSigningKey = (task, row) =>
          refuseLoser && row.kid.startsWith("loser") ? errAsync(outage) : insert(task, row);
        const destroy = h.secrets.destroySecret.bind(h.secrets);
        let refuseCleanup = true;
        h.secrets.destroySecret = (task, provider, version) =>
          refuseCleanup ? errAsync(outage) : destroy(task, provider, version);
        const run = await sim.runTasks([
          {
            name: "boot",
            f: async (task) => {
              expect(
                (await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })).isErr(),
              ).toBe(true);
              const active = (
                await ensureActiveSigningKey(task, winner.deps, { now: task.wallNow() })
              )._unsafeUnwrap();
              for (let attempt = 0; attempt < 2; attempt++) {
                await task.checkpoint("race loser retries cleanup while winner remains usable");
                expect(
                  (
                    await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })
                  )._unsafeUnwrap().kid,
                ).toBe(active.kid);
              }
              expect(log.matching("issuer-key-cleanup-failed")).toHaveLength(1);
              expect(log.matching("issuer-key-race-lost")).toHaveLength(0);
              refuseCleanup = false;
              refuseLoser = false;
              expect(
                (
                  await ensureActiveSigningKey(task, h.deps, { now: task.wallNow() })
                )._unsafeUnwrap().kid,
              ).toBe(active.kid);
              expect(h.secrets.liveVersions(SIGNING_KEY_SECRET_PROVIDER)).toEqual([
                active.secretVersion,
              ]);
              expect(h.secrets.destroyedVersions()).not.toContain(
                `${SIGNING_KEY_SECRET_PROVIDER}/${active.secretVersion}`,
              );
              expect(log.matching("issuer-key-race-lost")).toHaveLength(1);
              expect(h.generator.generated).toBe(1);
              expect(log.lines().join("\n")).not.toContain("privateKeyPem");
              expect(log.lines().join("\n")).not.toContain("fake-private-key:");
            },
          },
        ]);
        if (run.isErr()) throw run.error;
      },
    );
  });
});

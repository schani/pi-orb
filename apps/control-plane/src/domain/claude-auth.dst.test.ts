import type { Simulation, SimulationTask } from "determined";
import { errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { FakePointerStore, FakeSecretStore } from "../testkit/broker.ts";
import { runDst } from "../testkit/sim.ts";
import {
  type ClaudeAuthError,
  type ClaudeAuthEvent,
  type ClaudeAuthSession,
  type ClaudeAuthTransport,
  ClaudeSubscriptionAuth,
} from "./claude-auth.ts";
import type { CredentialPointerWrite } from "./ports.ts";

class FakeTransport implements ClaudeAuthTransport {
  readonly listeners: ((event: ClaudeAuthEvent) => void)[] = [];
  drainFailure = false;
  start: ClaudeAuthTransport["start"] = (emit) => {
    this.listeners.push(emit);
    return okAsync({
      sendCode: () => ok(undefined),
      cancel: () => ok(undefined),
      drain: () =>
        this.drainFailure
          ? errAsync({
              code: "unavailable" as const,
              stage: "cleanup" as const,
              message: "Claude sign-in cleanup failed",
            })
          : okAsync(undefined),
    });
  };
}
class AmbiguousPointerStore extends FakePointerStore {
  override casWritePointer(
    task: SimulationTask,
    provider: string,
    expected: number | null,
    next: CredentialPointerWrite,
  ) {
    return super.casWritePointer(task, provider, expected, next).andThen(() =>
      errAsync({
        type: "store_error" as const,
        code: "unavailable" as const,
        message: "commit acknowledgement lost",
        retryable: true,
      }),
    );
  }
}

class CancelFailurePointerStore extends FakePointerStore {
  onPublished: (() => void) | undefined;
  override casWritePointer(
    task: SimulationTask,
    provider: string,
    expected: number | null,
    next: CredentialPointerWrite,
  ) {
    if (expected !== null)
      return errAsync({
        type: "store_error" as const,
        code: "unavailable" as const,
        message: "clear refused",
        retryable: true,
      });
    return super.casWritePointer(task, provider, expected, next).map((row) => {
      this.onPublished?.();
      return row;
    });
  }
}

async function assertTasksSucceeded(
  sim: Simulation,
  specs: Parameters<Simulation["runTasks"]>[0],
): Promise<void> {
  const result = await sim.runTasks(specs);
  expect(result.isErr() ? result.error : null).toBeNull();
}

describe("Claude owner authentication", () => {
  for (const operation of ["cancel", "close", "disconnect"] as const)
    it(`${operation} waits for native exit and scratch cleanup`, async () => {
      await runDst({ name: `claude-${operation}-drain`, iterations: 10 }, async (sim) => {
        let release!: (result: Result<void, ClaudeAuthError>) => void;
        const drained = new ResultAsync<void, ClaudeAuthError>(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        const drain = vi.fn(() => drained);
        const transport: ClaudeAuthTransport = {
          start: () =>
            okAsync({ sendCode: () => ok(undefined), cancel: () => ok(undefined), drain }),
        };
        const auth = new ClaudeSubscriptionAuth(
          { forUser: () => new FakePointerStore() },
          new FakeSecretStore(),
          transport,
        );
        await assertTasksSucceeded(sim, [
          {
            name: "drain-driver",
            f: async (task) => {
              await auth.connect(task, "a");
              let finished = false;
              const pending = Promise.resolve(
                operation === "close" ? auth.close(task) : auth[operation](task, "a"),
              ).then((result) => {
                finished = true;
                return result;
              });
              await task.checkpoint("native helper still running");
              expect(drain).toHaveBeenCalledTimes(1);
              expect(finished).toBe(false);
              release(ok(undefined));
              expect((await pending)?.isOk()).toBe(true);
            },
          },
        ]);
      });
    });
  for (const operation of ["cancel", "close", "disconnect"] as const)
    it(`${operation} fences a native helper still being acquired`, async () => {
      await runDst(
        { name: `claude-${operation}-acquiring-helper`, iterations: 10 },
        async (sim) => {
          let acquire!: (result: Result<ClaudeAuthSession, ClaudeAuthError>) => void;
          let drainRelease!: (result: Result<void, ClaudeAuthError>) => void;
          let startEntered!: () => void;
          const entered = new Promise<void>((resolve) => {
            startEntered = resolve;
          });
          const drain = vi.fn(
            () =>
              new ResultAsync<void, ClaudeAuthError>(
                new Promise((resolve) => {
                  drainRelease = resolve;
                }),
              ),
          );
          const cancel = vi.fn(() => ok(undefined));
          const transport: ClaudeAuthTransport = {
            start: () => {
              startEntered();
              return new ResultAsync(
                new Promise((resolve) => {
                  acquire = resolve;
                }),
              );
            },
          };
          const secrets = new FakeSecretStore();
          const auth = new ClaudeSubscriptionAuth(
            { forUser: () => new FakePointerStore() },
            secrets,
            transport,
          );
          await assertTasksSucceeded(sim, [
            {
              name: "acquisition-driver",
              f: async (task) => {
                const connecting = auth.connect(task, "a");
                await entered;
                let finished = false;
                const stopping = Promise.resolve(
                  operation === "close" ? auth.close(task) : auth[operation](task, "a"),
                ).then((result) => {
                  finished = true;
                  return result;
                });
                await task.checkpoint("cancel before native acquisition");
                expect(finished).toBe(false);
                acquire(ok({ sendCode: () => ok(undefined), cancel, drain }));
                await connecting;
                await task.checkpoint("acquired native helper awaiting exit");
                expect(cancel).toHaveBeenCalledTimes(1);
                expect(drain).toHaveBeenCalledTimes(1);
                expect(finished).toBe(false);
                drainRelease(ok(undefined));
                expect((await stopping).isOk()).toBe(true);
                expect((await auth.close(task)).isOk()).toBe(true);
                expect(secrets.liveVersions("claude-subscription")).toEqual([]);
              },
            },
          ]);
        },
      );
    });
  for (const operation of ["cancel", "close"] as const)
    it(`${operation} fences code submission immediately`, async () => {
      await runDst({ name: `claude-${operation}-code-fence`, iterations: 10 }, async (sim) => {
        const sendCode = vi.fn(() => ok(undefined));
        const transport: ClaudeAuthTransport = {
          start: () =>
            okAsync({ sendCode, cancel: () => ok(undefined), drain: () => okAsync(undefined) }),
        };
        const auth = new ClaudeSubscriptionAuth(
          { forUser: () => new FakePointerStore() },
          new FakeSecretStore(),
          transport,
        );
        await assertTasksSucceeded(sim, [
          {
            name: "code-fence-driver",
            f: async (task) => {
              await auth.connect(task, "a");
              const stopping = operation === "close" ? auth.close(task) : auth.cancel(task, "a");
              expect((await auth.code(task, "a", "synthetic-code")).isErr()).toBe(true);
              expect(sendCode).not.toHaveBeenCalled();
              expect((await stopping).isOk()).toBe(true);
            },
          },
        ]);
      });
    });
  it("replacement waits for failed helper drain and fences its late token", async () => {
    await runDst({ name: "claude-replacement-drain", iterations: 20 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      let release!: (result: Result<void, ClaudeAuthError>) => void;
      const oldDrain = new ResultAsync<void, ClaudeAuthError>(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const listeners: ((event: ClaudeAuthEvent) => void)[] = [];
      const transport: ClaudeAuthTransport = {
        start: (emit) => {
          listeners.push(emit);
          return okAsync({
            sendCode: () => ok(undefined),
            cancel: () => ok(undefined),
            drain: () => (listeners.length === 1 ? oldDrain : okAsync(undefined)),
          });
        },
      };
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "replacement-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            listeners[0]?.({ error: "safe failure", stage: "transport" });
            const replacing = auth.connect(task, "a");
            await task.checkpoint("old helper awaiting exit before replacement");
            expect(listeners).toHaveLength(1);
            listeners[0]?.({ token: "stale-token" });
            release(ok(undefined));
            expect((await replacing).isOk()).toBe(true);
            expect(listeners).toHaveLength(2);
            listeners[1]?.({ token: "new-token" });
            await auth.status(task, "a");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("new-token");
            expect(secrets.liveVersions("claude-subscription")).toHaveLength(1);
            expect((await auth.close(task)).isOk()).toBe(true);
          },
        },
      ]);
    });
  });
  it("concurrent disconnect and competing publication never retain a cancelled token", async () => {
    await runDst({ name: "claude-concurrent-cancel-publication", iterations: 100 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const factory = { forUser: () => pointers };
      const oldTransport = new FakeTransport();
      const nextTransport = new FakeTransport();
      const old = new ClaudeSubscriptionAuth(factory, secrets, oldTransport);
      const next = new ClaudeSubscriptionAuth(factory, secrets, nextTransport);
      let acquired = 0;
      let release!: () => void;
      const bothAcquired = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = () => {
        if (++acquired === 2) release();
      };
      await assertTasksSucceeded(sim, [
        {
          name: "cancel-publication",
          f: async (task) => {
            await old.connect(task, "a");
            ready();
            await bothAcquired;
            oldTransport.listeners[0]?.({ token: "cancelled-token" });
            expect((await old.disconnect(task, "a")).isOk()).toBe(true);
            oldTransport.listeners[0]?.({ token: "late-token" });
          },
        },
        {
          name: "competing-publication",
          f: async (task) => {
            await next.connect(task, "a");
            ready();
            await bothAcquired;
            nextTransport.listeners[0]?.({ token: "competing-token" });
            await next.status(task, "a");
          },
        },
      ]);
      await assertTasksSucceeded(sim, [
        {
          name: "verify",
          f: async (task) => {
            const grant = (await next.grant(task, "a"))._unsafeUnwrap();
            expect(grant?.token ?? null).not.toBe("cancelled-token");
            expect(grant?.token ?? null).not.toBe("late-token");
            expect(secrets.liveVersions("claude-subscription")).toHaveLength(
              grant === null ? 0 : 1,
            );
            pointers.assertGenerationMonotonic();
            expect((await old.close(task)).isOk()).toBe(true);
            expect((await next.close(task)).isOk()).toBe(true);
          },
        },
      ]);
    });
  });
  it("a late token from another instance cannot replace a newer canonical owner grant", async () => {
    await runDst({ name: "claude-cross-instance-cas", iterations: 20 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const factory = { forUser: () => pointers };
      const oldTransport = new FakeTransport();
      const nextTransport = new FakeTransport();
      const old = new ClaudeSubscriptionAuth(factory, secrets, oldTransport);
      const next = new ClaudeSubscriptionAuth(factory, secrets, nextTransport);
      await assertTasksSucceeded(sim, [
        {
          name: "cas-driver",
          f: async (task) => {
            await old.connect(task, "a");
            await next.connect(task, "a");
            nextTransport.listeners[0]?.({ token: "new-token" });
            await next.status(task, "a");
            oldTransport.listeners[0]?.({ token: "late-token" });
            expect((await old.status(task, "a"))._unsafeUnwrap().status).toBe("failed");
            expect((await next.grant(task, "a"))._unsafeUnwrap()?.token).toBe("new-token");
            expect(secrets.liveVersions("claude-subscription")).toHaveLength(1);
            await old.close(task);
            await next.disconnect(task, "a");
            oldTransport.listeners[0]?.({ token: "late-after-disconnect" });
            expect((await next.grant(task, "a"))._unsafeUnwrap()).toBeNull();
            expect(secrets.liveVersions("claude-subscription")).toEqual([]);
          },
        },
      ]);
    });
  });
  it("retries a start failure only when the adapter confirms no undrained helper", async () => {
    for (const stage of [undefined, "exit", "cleanup"] as const)
      await runDst(
        { name: `claude-start-failure-${stage ?? "unallocated"}`, iterations: 10 },
        async (sim) => {
          let starts = 0;
          const transport: ClaudeAuthTransport = {
            start: () => {
              starts++;
              return starts === 1
                ? errAsync({
                    code: "unavailable" as const,
                    message: "safe start failure",
                    ...(stage ? { stage } : {}),
                  })
                : okAsync({
                    sendCode: () => ok(undefined),
                    cancel: () => ok(undefined),
                    drain: () => okAsync(undefined),
                  });
            },
          };
          const auth = new ClaudeSubscriptionAuth(
            { forUser: () => new FakePointerStore() },
            new FakeSecretStore(),
            transport,
          );
          await assertTasksSucceeded(sim, [
            {
              name: "failed-start-driver",
              f: async (task) => {
                expect((await auth.connect(task, "a")).isErr()).toBe(true);
                const retried = await auth.connect(task, "a");
                expect(retried.isOk()).toBe(stage === undefined);
                expect(starts).toBe(stage === undefined ? 2 : 1);
                expect((await auth.close(task)).isOk()).toBe(stage === undefined);
              },
            },
          ]);
        },
      );
  });
  it("surfaces drain failure without clearing a previously connected grant", async () => {
    await runDst({ name: "claude-cleanup-failure", iterations: 10 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "cleanup-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "retained-token" });
            await auth.status(task, "a");
            transport.drainFailure = true;
            expect((await auth.cancel(task, "a")).isErr()).toBe(true);
            expect((await auth.status(task, "a"))._unsafeUnwrap().status).toBe("failed");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("retained-token");
            expect((await auth.close(task)).isErr()).toBe(true);
            expect((await auth.connect(task, "a")).isErr()).toBe(true);
          },
        },
      ]);
    });
  });
  it("distinguishes accepted code, native input completion, and exchange failure without secrets", async () => {
    await runDst({ name: "claude-native-input-telemetry", iterations: 1 }, async (sim) => {
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth(
        { forUser: () => new FakePointerStore() },
        new FakeSecretStore(),
        transport,
      );
      await assertTasksSucceeded(sim, [
        {
          name: "submit",
          f: async (task) => {
            const logged = vi.spyOn(task, "log");
            await auth.connect(task, "a");
            transport.listeners[0]?.({ challenge: { needsCode: true } });
            expect((await auth.code(task, "a", "private-code"))._unsafeUnwrap()).toEqual({
              status: "connecting",
            });
            expect((await auth.code(task, "a", "duplicate-private-code")).isErr()).toBe(true);
            transport.listeners[0]?.({ progress: "input_completed" });
            transport.listeners[0]?.({
              error: "safe error",
              stage: "native_exchange",
              reason: "network",
            });
            expect((await auth.status(task, "a"))._unsafeUnwrap()).toEqual({
              status: "failed",
              error: "Claude sign-in failed; reconnect",
            });
            const lines = logged.mock.calls.map(([line]) => String(line));
            expect(lines.some((line) => line.includes("claude-auth-code-accepted"))).toBe(true);
            expect(lines.some((line) => line.includes("claude-auth-input-completed"))).toBe(true);
            expect(
              lines.some(
                (line) =>
                  line.includes("stage=native_exchange") &&
                  line.includes("reason=network") &&
                  line.includes("inputCompleted=true"),
              ),
            ).toBe(true);
            expect(lines.join("\n")).not.toContain("private-code");
            logged.mockRestore();
          },
        },
      ]);
    });
  });
  it("logs cancellation acceptance, not provider-process exit", async () => {
    await runDst({ name: "claude-cancel-telemetry", iterations: 1 }, async (sim) => {
      const pointers = new FakePointerStore();
      const auth = new ClaudeSubscriptionAuth(
        { forUser: () => pointers },
        new FakeSecretStore(),
        new FakeTransport(),
      );
      await assertTasksSucceeded(sim, [
        {
          name: "cancel",
          f: async (task) => {
            const logged = vi.spyOn(task, "log");
            await auth.connect(task, "a");
            await auth.cancel(task, "a");
            await auth.close(task);
            const lines = logged.mock.calls
              .map(([line]) => line)
              .filter(
                (line): line is string =>
                  typeof line === "string" &&
                  (line.includes("claude-auth-cancel-requested") ||
                    line.includes("claude-auth-shutdown")),
              );
            expect(lines).toHaveLength(2);
            for (const line of lines) {
              expect(line).toContain("cancelAccepted=true");
              expect(line).not.toContain("terminated=");
            }
            const proof = logged.mock.calls
              .map(([line]) => String(line))
              .filter((line) => line.includes("claude-auth-drained"));
            expect(proof).toHaveLength(1);
            expect(proof[0]).toContain("exitObserved=true");
            expect(proof[0]).toContain("scratchRemoved=true");
            logged.mockRestore();
          },
        },
      ]);
    });
  });
  it("does not claim cancellation when the committed grant cannot be cleared", async () => {
    await runDst({ name: "claude-cancel-clear-failed", iterations: 10 }, async (sim) => {
      const pointers = new CancelFailurePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "cancel-clear-failed",
          f: async (task) => {
            pointers.onPublished = () => {
              void auth.cancel(task, "a");
            };
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "private-token" });
            expect((await auth.status(task, "a"))._unsafeUnwrap().status).toBe("failed");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("private-token");
            expect(secrets.destroyedVersions()).toEqual([]);
          },
        },
      ]);
    });
  });
  it("never clears a newer owner credential during cancellation readback", async () => {
    await runDst({ name: "claude-cancel-newer-publication", iterations: 10 }, async (sim) => {
      const pointers = new CancelFailurePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "newer-publication-driver",
          f: async (task) => {
            pointers.onPublished = () => {
              void auth.cancel(task, "a");
              const version = secrets.seedSecret("claude-subscription", {
                kind: "claude_subscription",
                token: "newer-token",
                createdAt: task.wallNow(),
              });
              pointers.seedRow({
                provider: "claude-subscription",
                rowVersion: 2,
                generation: 10,
                secretVersion: version,
                refreshLeaseUntil: 0,
                lastRefreshAt: 0,
              });
            };
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "older-token" });
            await auth.status(task, "a");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("newer-token");
            expect(secrets.liveVersions("claude-subscription")).toHaveLength(1);
          },
        },
      ]);
    });
  });
  it("adopts ambiguous committed publication without destroying its secret", async () => {
    await runDst({ name: "claude-ambiguous-publication", iterations: 10 }, async (sim) => {
      const pointers = new AmbiguousPointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "ambiguous-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "private-token" });
            expect((await auth.status(task, "a"))._unsafeUnwrap().status).toBe("connected");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("private-token");
            expect(secrets.destroyedVersions()).toEqual([]);
          },
        },
      ]);
    });
  });
  it("confirms ambiguous disconnect by readback before destroying its static version", async () => {
    await runDst({ name: "claude-ambiguous-disconnect", iterations: 10 }, async (sim) => {
      const pointers = new AmbiguousPointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "disconnect-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "private-token" });
            await auth.status(task, "a");
            expect((await auth.disconnect(task, "a"))._unsafeUnwrap().status).toBe("disconnected");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()).toBeNull();
            expect(secrets.liveVersions("claude-subscription")).toEqual([]);
          },
        },
      ]);
    });
  });
  it("cancels publication already admitted before its pointer commit", async () => {
    await runDst({ name: "claude-cancel-publication-race", iterations: 20 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "race-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "private-token" });
            await auth.cancel(task, "a");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()).toBeNull();
          },
        },
      ]);
    });
  });
  for (const failure of [false, true])
    it(`isolates owners and restart authority, publication failure=${failure}`, async () => {
      await runDst({ name: `claude-owner-publication-${failure}`, iterations: 10 }, async (sim) => {
        const a = new FakePointerStore();
        const b = new FakePointerStore();
        const secrets = new FakeSecretStore();
        const transport = new FakeTransport();
        const factory = { forUser: (id: string) => (id === "a" ? a : b) };
        const auth = new ClaudeSubscriptionAuth(factory, secrets, transport);
        await assertTasksSucceeded(sim, [
          {
            name: "owner-driver",
            f: async (task) => {
              expect((await auth.status(task, "a"))._unsafeUnwrap().status).toBe("disconnected");
              await auth.connect(task, "a");
              await auth.connect(task, "a");
              expect(transport.listeners).toHaveLength(1);
              secrets.failWrites = failure;
              transport.listeners[0]?.({ token: "private-token" });
              const view = (await auth.status(task, "a"))._unsafeUnwrap();
              expect(view.status).toBe(failure ? "failed" : "connected");
              expect(JSON.stringify(view)).not.toContain("private-token");
              expect((await auth.grant(task, "b"))._unsafeUnwrap()).toBeNull();
              const restarted = new ClaudeSubscriptionAuth(factory, secrets, transport);
              expect((await restarted.status(task, "a"))._unsafeUnwrap().status).toBe(
                failure ? "disconnected" : "connected",
              );
              await auth.disconnect(task, "a");
              expect((await auth.grant(task, "a"))._unsafeUnwrap()).toBeNull();
            },
          },
        ]);
      });
    });
  it("exposes renewal challenge while the previous grant stays usable", async () => {
    await runDst({ name: "claude-renewal-challenge", iterations: 10 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "renewal-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "previous-token" });
            await auth.status(task, "a");
            await auth.connect(task, "a");
            transport.listeners[1]?.({ challenge: { needsCode: true } });
            expect((await auth.status(task, "a"))._unsafeUnwrap()).toEqual({
              status: "connecting",
              challenge: { needsCode: true },
            });
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("previous-token");
            await auth.cancel(task, "a");
          },
        },
      ]);
    });
  });
  it("cleans superseded static versions only after canonical renewal", async () => {
    await runDst({ name: "claude-renewal-cleanup", iterations: 10 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "renewal-cleanup",
          f: async (task) => {
            await auth.connect(task, "a");
            transport.listeners[0]?.({ token: "previous-token" });
            await auth.status(task, "a");
            await auth.connect(task, "a");
            transport.listeners[1]?.({ token: "next-token" });
            await auth.status(task, "a");
            expect((await auth.grant(task, "a"))._unsafeUnwrap()?.token).toBe("next-token");
            expect(secrets.liveVersions("claude-subscription")).toHaveLength(1);
            expect(secrets.destroyedVersions()).toHaveLength(1);
          },
        },
      ]);
    });
  });
  it("restart discards incomplete flow without restarting native auth", async () => {
    await runDst({ name: "claude-restart-pending", iterations: 10 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "restart-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            await auth.close(task);
            transport.listeners[0]?.({ token: "late-token" });
            const restarted = new ClaudeSubscriptionAuth(
              { forUser: () => pointers },
              secrets,
              transport,
            );
            expect((await restarted.status(task, "a"))._unsafeUnwrap().status).toBe("disconnected");
            expect(transport.listeners).toHaveLength(1);
          },
        },
      ]);
    });
  });
  it("cancellation discards late completion", async () => {
    await runDst({ name: "claude-cancel-late-token", iterations: 10 }, async (sim) => {
      const pointers = new FakePointerStore();
      const secrets = new FakeSecretStore();
      const transport = new FakeTransport();
      const auth = new ClaudeSubscriptionAuth({ forUser: () => pointers }, secrets, transport);
      await assertTasksSucceeded(sim, [
        {
          name: "cancel-driver",
          f: async (task) => {
            await auth.connect(task, "a");
            await auth.cancel(task, "a");
            transport.listeners[0]?.({ token: "late-token" });
            expect((await auth.grant(task, "a"))._unsafeUnwrap()).toBeNull();
            expect(secrets.liveVersions("claude-subscription")).toEqual([]);
          },
        },
      ]);
    });
  });
});

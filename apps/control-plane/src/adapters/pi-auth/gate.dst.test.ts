import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getToken } from "../../domain/broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "../../domain/constants.ts";
import { reconcileOrbOnce } from "../../domain/lifecycle.ts";
import type { BrokerDeps, StoredCredential } from "../../domain/ports.ts";
import { FakePointerStore, FakeSecretStore, FakeUpstream } from "../../testkit/broker.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import {
  PreCommitFailureSecretStore,
  SupersedingLoginPointerStore,
} from "../../testkit/login-publication.ts";
import { LogCapture, runDst } from "../../testkit/sim.ts";
import { PiAuthGate } from "./gate.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const PROVIDER = "openai-codex";
const completed: StoredCredential = {
  access: "completed-access",
  refresh: "completed-refresh",
  accountId: "completed-account",
  expiresAt: 2_000_000_000_000,
};
const winner: StoredCredential = {
  access: "winner-access",
  refresh: "winner-refresh",
  accountId: "winner-account",
  expiresAt: 2_000_000_000_000,
};

type LoginOptions = Parameters<ModelRuntime["login"]>[2];

class FakePiRuntime {
  loginCalls = 0;
  private resolveLogin: (() => void) | null = null;
  private rejectLogin: ((error: unknown) => void) | null = null;
  private options: LoginOptions | null = null;
  private readonly notifyImmediately: boolean;

  constructor(notifyImmediately = true) {
    this.notifyImmediately = notifyImmediately;
  }

  login(_provider: string, _method: string, options: LoginOptions): Promise<void> {
    this.loginCalls += 1;
    this.options = options;
    if (this.notifyImmediately) this.emitChallenge();
    return new Promise((resolve, reject) => {
      this.resolveLogin = resolve;
      this.rejectLogin = reject;
    });
  }

  emitChallenge(): void {
    this.options?.notify?.({
      type: "device_code",
      verificationUri: "https://login.test/device",
      userCode: "CODE",
      expiresInSeconds: 900,
    });
  }

  approve(): void {
    this.resolveLogin?.();
  }

  reject(error: unknown): void {
    this.rejectLogin?.(error);
  }

  asRuntime(): ModelRuntime {
    return this as unknown as ModelRuntime;
  }
}

function deps(pointers: BrokerDeps["pointers"], secrets: FakeSecretStore): BrokerDeps {
  return {
    pointers,
    secrets,
    upstreams: { [PROVIDER]: new FakeUpstream("unused") },
    constants: DEFAULT_BROKER_CONSTANTS,
  };
}

describe("Pi auth gate login publication (DST)", () => {
  it("keeps one live SDK login through challenge delay and canonical credential changes", async () => {
    await runDst({ name: "pi-gate-single-live-login", iterations: 20 }, async (sim) => {
      const secrets = new FakeSecretStore();
      const pointers = new FakePointerStore();
      const broker = deps(pointers, secrets);
      const runtime = new FakePiRuntime(false);
      let runtimeCreations = 0;
      let reads = 0;
      const gate = new PiAuthGate(
        "/tmp/pi-auth-gate-single-live-dst",
        null,
        () => broker,
        async () => {
          runtimeCreations += 1;
          return runtime.asRuntime();
        },
        () => {
          reads += 1;
          return {
            type: "oauth" as const,
            access: completed.access,
            refresh: completed.refresh,
            expires: completed.expiresAt,
          };
        },
      );

      const result = await sim.runTasks([
        {
          name: "caller",
          f: async (task) => {
            const preparing = (await gate.ensureAuth(task, USER))._unsafeUnwrap();
            expect(preparing).toMatchObject({
              status: "pending",
              challenge: { userCode: "", verificationUri: "" },
            });
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap()).toMatchObject({
              status: "pending",
              challenge: { userCode: "" },
            });
            expect(runtime.loginCalls).toBe(1);
            expect(runtimeCreations).toBe(1);

            runtime.emitChallenge();
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap()).toMatchObject({
              status: "pending",
              challenge: { userCode: "CODE", verificationUri: "https://login.test/device" },
            });

            const canonicalVersion = secrets.seedSecret(PROVIDER, winner);
            pointers.seedRow({
              provider: PROVIDER,
              rowVersion: 1,
              generation: 1,
              secretVersion: canonicalVersion,
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
            });
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe("ok");
            pointers.seedRow({
              provider: PROVIDER,
              rowVersion: 2,
              generation: 2,
              secretVersion: null,
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
            });
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe("pending");
            expect(runtime.loginCalls).toBe(1);
            expect(runtimeCreations).toBe(1);
            expect(reads).toBe(0);

            runtime.approve();
            await task.sleep(1, "original Pi login completion");
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe("ok");
            expect(runtime.loginCalls).toBe(1);
            expect(runtimeCreations).toBe(1);
            expect(reads).toBe(1);

            pointers.seedRow({
              provider: PROVIDER,
              rowVersion: 4,
              generation: 4,
              secretVersion: null,
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
            });
            expect((await gate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe("pending");
            expect(runtime.loginCalls).toBe(2);
            expect(runtimeCreations).toBe(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("redacts opaque SDK, runtime, and credential-reader errors", async () => {
    await runDst({ name: "pi-gate-error-redaction", iterations: 10 }, async (sim) => {
      const leaked = "token=secret CODE-LEAK https://login.test/leak";
      const broker = deps(new FakePointerStore(), new FakeSecretStore());
      const rejectedRuntime = new FakePiRuntime();
      const loginGate = new PiAuthGate(
        "/tmp/pi-auth-gate-redaction-login-dst",
        null,
        () => broker,
        async () => rejectedRuntime.asRuntime(),
      );
      const runtimeGate = new PiAuthGate(
        "/tmp/pi-auth-gate-redaction-runtime-dst",
        null,
        () => broker,
        async () => Promise.reject(new Error(leaked)),
      );
      const completedRuntime = new FakePiRuntime();
      const readerGate = new PiAuthGate(
        "/tmp/pi-auth-gate-redaction-reader-dst",
        null,
        () => broker,
        async () => completedRuntime.asRuntime(),
        () => {
          throw new Error(leaked);
        },
      );

      const result = await sim.runTasks([
        {
          name: "redaction",
          f: async (task) => {
            expect((await loginGate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe("pending");
            rejectedRuntime.reject(new Error(leaked));
            await task.sleep(1, "opaque login rejection");
            const loginError = (await loginGate.ensureAuth(task, USER))._unsafeUnwrapErr();
            expect(loginError.message).toBe("Codex login failed temporarily");

            const runtimeError = (await runtimeGate.ensureAuth(task, USER))._unsafeUnwrapErr();
            expect(runtimeError.message).toBe("failed to initialize Codex login");

            expect((await readerGate.ensureAuth(task, USER))._unsafeUnwrap().status).toBe(
              "pending",
            );
            completedRuntime.approve();
            await task.sleep(1, "completed login before failed read");
            const readerError = (await readerGate.ensureAuth(task, USER))._unsafeUnwrapErr();
            expect(readerError.message).toBe("failed to read completed Codex login");
            expect(
              `${loginError.message} ${runtimeError.message} ${readerError.message}`,
            ).not.toContain(leaked);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("keeps an opaque SDK login rejection retryable while another owner stays healthy", async () => {
    const log = new LogCapture();
    const leaked = "token=secret CODE-LEAK https://login.test/leak";
    await runDst(
      { name: "pi-gate-transient-owner-isolation", iterations: 20, logCapture: log },
      async (sim) => {
        const userA = USER;
        const userB = "00000000-0000-4000-8000-000000000002";
        const secrets = new FakeSecretStore();
        const pointersA = new FakePointerStore();
        const pointersB = new FakePointerStore();
        const healthy = secrets.seedSecret(PROVIDER, winner);
        pointersB.seedRow({
          provider: PROVIDER,
          rowVersion: 1,
          generation: 1,
          secretVersion: healthy,
          refreshLeaseUntil: 0,
          lastRefreshAt: 0,
        });
        const brokers = new Map([
          [userA, deps(pointersA, secrets)],
          [userB, deps(pointersB, secrets)],
        ]);
        const runtimes = new Map<string, FakePiRuntime>();
        const gate = new PiAuthGate(
          "/tmp/pi-auth-gate-owner-isolation-dst",
          null,
          (userId) => brokers.get(userId) ?? deps(new FakePointerStore(), secrets),
          async (authPath) => {
            const runtime = new FakePiRuntime();
            runtimes.set(authPath.includes(userA) ? userA : userB, runtime);
            return runtime.asRuntime();
          },
        );

        const harness = makeHarness();
        const projectA = { ...makeProjectRow("pi-gate-project-a"), ownerUserId: userA };
        const projectB = { ...makeProjectRow("pi-gate-project-b"), ownerUserId: userB };
        harness.store.seedProject(projectA);
        harness.store.seedProject(projectB);
        harness.store.seedOrb(makeOrbRow("pi-gate-orb-a", projectA.id, "creating"));
        harness.store.seedOrb(makeOrbRow("pi-gate-orb-b", projectB.id, "creating"));
        harness.deps.control.markAuthBlocked("pi-gate-orb-a", userA, PROVIDER);
        harness.deps.control.markAuthBlocked("pi-gate-orb-b", userB, PROVIDER);
        const controlDeps = { ...harness.deps, authGate: gate };

        const result = await sim.runTasks([
          {
            name: "transient-owner",
            f: async (task) => {
              const pending = await gate.ensureAuth(task, userA);
              expect(pending.isOk() && pending.value.status).toBe("pending");
              runtimes.get(userA)?.reject(new Error(leaked));
              await task.sleep(1, "Pi login rejection");
              const outcome = await reconcileOrbOnce(task, controlDeps, "pi-gate-orb-a");
              return outcome.type;
            },
          },
          {
            name: "healthy-owner",
            f: async (task) => {
              const resolution = await gate.ensureAuth(task, userB);
              return resolution._unsafeUnwrap().status;
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        if (result.isErr()) return;
        expect(result.value).toEqual(["retryable", "ok"]);
        expect(harness.deps.control.getAuthBlockedOrbs(userA)).toEqual(["pi-gate-orb-a"]);
        expect(harness.deps.control.getAuthBlockedOrbs(userB)).toEqual(["pi-gate-orb-b"]);
        expect(pointersB.snapshot(PROVIDER)?.secretVersion).toBe(healthy);
        expect(secrets.destroyedVersions()).not.toContain(`${PROVIDER}/${healthy}`);
        expect(log.lines().join("\n")).not.toContain(leaked);
      },
    );
  });

  it("drops an ambiguously published pair and recovers the newer canonical credential", async () => {
    await runDst({ name: "pi-gate-ambiguous-login-publication", iterations: 20 }, async (sim) => {
      const secrets = new FakeSecretStore();
      const winnerVersion = secrets.seedSecret(PROVIDER, winner);
      const pointers = new SupersedingLoginPointerStore({
        provider: PROVIDER,
        rowVersion: 2,
        generation: 2,
        secretVersion: winnerVersion,
        refreshLeaseUntil: 0,
        lastRefreshAt: 0,
      });
      const broker = deps(pointers, secrets);
      let runtime: FakePiRuntime | null = null;
      const gate = new PiAuthGate(
        "/tmp/pi-auth-gate-dst",
        null,
        () => broker,
        async () => {
          runtime = new FakePiRuntime();
          return runtime.asRuntime();
        },
        () => ({
          type: "oauth" as const,
          access: completed.access,
          refresh: completed.refresh,
          expires: completed.expiresAt,
        }),
      );
      const result = await sim.runTasks([
        {
          name: "caller",
          f: async (task) => {
            const started = await gate.ensureAuth(task, USER);
            expect(started.isOk() && started.value.status).toBe("pending");
            runtime?.approve();
            await task.sleep(1, "Pi login completion");
            const uncertain = await gate.ensureAuth(task, USER);
            expect(uncertain.isErr()).toBe(true);
            const recovered = await gate.ensureAuth(task, USER);
            expect(recovered.isOk() && recovered.value.status).toBe("ok");
            return await getToken(task, broker, PROVIDER, { reason: "startup" });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (result.isErr()) return;
      expect(result.value[0]?._unsafeUnwrap().accessToken).toBe(winner.access);
      expect(pointers.casCalls).toBe(1);
      expect(pointers.committedWrites).toHaveLength(1);
      expect(pointers.committedWrites[0]?.secretVersion).not.toBe(winnerVersion);
      expect(pointers.snapshot(PROVIDER)?.secretVersion).toBe(winnerVersion);
      expect((runtime as FakePiRuntime | null)?.loginCalls).toBe(1);
    });
  });

  it("retains completed material after a known pre-commit failure and retries it", async () => {
    await runDst({ name: "pi-gate-precommit-login-retry", iterations: 20 }, async (sim) => {
      const secrets = new PreCommitFailureSecretStore();
      const pointers = new FakePointerStore();
      const broker = deps(pointers, secrets);
      let runtime: FakePiRuntime | null = null;
      const gate = new PiAuthGate(
        "/tmp/pi-auth-gate-retry-dst",
        null,
        () => broker,
        async () => {
          runtime = new FakePiRuntime();
          return runtime.asRuntime();
        },
        () => ({
          type: "oauth" as const,
          access: completed.access,
          refresh: completed.refresh,
          expires: completed.expiresAt,
        }),
      );
      const result = await sim.runTasks([
        {
          name: "caller",
          f: async (task) => {
            if (runtime === null) {
              const pending = await gate.ensureAuth(task, USER);
              expect(pending.isOk() && pending.value.status).toBe("pending");
            }
            runtime?.approve();
            await task.sleep(1, "Pi login completion");
            expect((await gate.ensureAuth(task, USER)).isErr()).toBe(true);
            const retried = await gate.ensureAuth(task, USER);
            expect(retried.isOk() && retried.value.status).toBe("ok");
            return await getToken(task, broker, PROVIDER, { reason: "startup" });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (result.isErr()) return;
      expect(result.value[0]?._unsafeUnwrap().accessToken).toBe(completed.access);
      expect(secrets.writeCalls).toBe(2);
      expect(secrets.retriedCredentials).toMatchObject([
        { access: completed.access, refresh: completed.refresh },
      ]);
      expect(pointers.committedWrites).toHaveLength(1);
      expect((runtime as FakePiRuntime | null)?.loginCalls).toBe(1);
    });
  });
});

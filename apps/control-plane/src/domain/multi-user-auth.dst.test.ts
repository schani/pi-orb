import type { SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FakePointerStore, FakeSecretStore, FakeUpstream } from "../testkit/broker.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { SerializedAuthGate } from "./auth-gates.ts";
import { bindUserBroker, getToken, type UserBrokerDeps } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce } from "./lifecycle.ts";
import type {
  AuthGate,
  AuthResolution,
  CredentialPointerStore,
  CredentialPointerStoreFactory,
} from "./ports.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const PROVIDER = "openai-codex";

class UserPointerFactory implements CredentialPointerStoreFactory {
  readonly stores = new Map<string, FakePointerStore>();
  forUser(userId: string): CredentialPointerStore {
    let store = this.stores.get(userId);
    if (store === undefined) {
      store = new FakePointerStore();
      this.stores.set(userId, store);
    }
    return store;
  }
}

class OutageGate implements AuthGate {
  outageUser: string | null = null;

  ensureAuth(_task: SimulationTask, userId: string) {
    if (this.outageUser === userId) {
      return errAsync({
        type: "auth_gate_error" as const,
        message: "credential store unavailable",
        retryable: true,
      });
    }
    return ResultAsync.fromSafePromise(
      Promise.resolve<AuthResolution>({
        status: "pending",
        challenge: {
          provider: "openai-codex",
          verificationUri: `https://login.test/${userId}`,
          userCode: userId === A ? "ALICE" : "BOB",
          expiresAt: 10_000,
        },
      }),
    );
  }
}

class ProviderSequenceGate implements AuthGate {
  private call = 0;

  ensureAuth(_task: SimulationTask, _userId: string) {
    this.call += 1;
    const provider = this.call === 1 ? "openai-codex" : "github";
    const resolution: AuthResolution =
      this.call <= 2
        ? {
            status: "pending",
            challenge: {
              provider,
              verificationUri: `https://login.test/${provider}`,
              userCode: provider,
              expiresAt: 10_000,
            },
          }
        : { status: "ok" };
    return ResultAsync.fromSafePromise(Promise.resolve(resolution));
  }
}

class PerUserPendingGate implements AuthGate {
  readonly calls = new Map<string, number>();
  ensureAuth(task: SimulationTask, userId: string) {
    this.calls.set(userId, (this.calls.get(userId) ?? 0) + 1);
    return ResultAsync.fromSafePromise(
      task.sleep(5, `hold ${userId} auth wave`).then(
        (): AuthResolution => ({
          status: "pending",
          challenge: {
            provider: "openai-codex",
            verificationUri: `https://login.test/${userId}`,
            userCode: userId === A ? "ALICE" : "BOB",
            expiresAt: 10_000,
          },
        }),
      ),
    );
  }
}

describe("multi-user credential/auth composition (DST)", () => {
  it("logs provider transitions and preserves the resolved provider", async () => {
    const log = new LogCapture();
    await runDst(
      { name: "auth-provider-edge-observability", iterations: 10, logCapture: log },
      async (sim) => {
        const harness = makeHarness();
        const gate = new ProviderSequenceGate();
        const project = { ...makeProjectRow("project-provider-edge"), ownerUserId: A };
        harness.store.seedProject(project);
        harness.store.seedOrb(makeOrbRow("orb-provider-edge", project.id, "creating"));
        const deps = { ...harness.deps, authGate: gate };

        const result = await sim.runTasks([
          {
            name: "provider-sequence",
            f: async (task) => {
              await reconcileOrbOnce(task, deps, "orb-provider-edge");
              await reconcileOrbOnce(task, deps, "orb-provider-edge");
              await reconcileOrbOnce(task, deps, "orb-provider-edge");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(log.matching("auth-blocked")).toHaveLength(2);
        expect(log.matching("auth-blocked")[0]).toContain("provider=openai-codex");
        expect(log.matching("auth-blocked")[1]).toContain("provider=github");
        expect(log.matching("auth-resolved")).toHaveLength(1);
        expect(log.matching("auth-resolved")[0]).toContain(`owner_user_id=${A}`);
        expect(log.matching("auth-resolved")[0]).toContain("provider=github");
      },
    );
  });

  it("runs independent serialized ceremonies and owner-keyed cohorts", async () => {
    await runDst({ name: "multi-user-independent-login-cohorts", iterations: 40 }, async (sim) => {
      const inner = new PerUserPendingGate();
      const gate = new SerializedAuthGate(inner);
      const result = await sim.runTasks([
        { name: "alice-1", f: async (task) => await gate.ensureAuth(task, A) },
        { name: "alice-2", f: async (task) => await gate.ensureAuth(task, A) },
        { name: "bob", f: async (task) => await gate.ensureAuth(task, B) },
      ]);
      expect(result.isOk()).toBe(true);
      expect(inner.calls.get(A)).toBe(1);
      expect(inner.calls.get(B)).toBe(1);
      if (result.isErr()) return;
      const codes = result.value.map((entry) =>
        entry.isOk() && entry.value.status === "pending" ? entry.value.challenge.userCode : "",
      );
      expect(codes.sort()).toEqual(["ALICE", "ALICE", "BOB"]);

      const control = new ControlState();
      control.markAuthBlocked("orb-a-1", A);
      control.markAuthBlocked("orb-a-2", A);
      control.markAuthBlocked("orb-b", B);
      expect(control.getAuthBlockedOrbs(A).sort()).toEqual(["orb-a-1", "orb-a-2"]);
      expect(control.getAuthBlockedOrbs(B)).toEqual(["orb-b"]);
    });
  });

  it("keeps a retryable owner outage nonterminal and preserves the other cohort", async () => {
    await runDst(
      { name: "multi-user-auth-outage-cohort-isolation", iterations: 30 },
      async (sim) => {
        const harness = makeHarness();
        const gate = new OutageGate();
        const deps = { ...harness.deps, authGate: gate };
        const projectA = { ...makeProjectRow("project-a"), ownerUserId: A };
        const projectB = { ...makeProjectRow("project-b"), ownerUserId: B };
        harness.store.seedProject(projectA);
        harness.store.seedProject(projectB);
        harness.store.seedOrb(makeOrbRow("orb-a", projectA.id, "creating"));
        harness.store.seedOrb(makeOrbRow("orb-b", projectB.id, "creating"));

        harness.deps.control.markAuthBlocked("orb-a", A);
        harness.deps.control.markAuthBlocked("orb-b", B);
        harness.deps.control.setChallenge(A, {
          provider: "openai-codex",
          verificationUri: "https://login.test/alice",
          userCode: "ALICE",
          expiresAt: 10_000,
        });
        harness.deps.control.setChallenge(B, {
          provider: "openai-codex",
          verificationUri: "https://login.test/bob",
          userCode: "BOB",
          expiresAt: 10_000,
        });
        gate.outageUser = A;
        const outage = await sim.runTasks([
          { name: "alice-store-outage", f: (task) => reconcileOrbOnce(task, deps, "orb-a") },
        ]);
        expect(outage.isOk()).toBe(true);
        if (outage.isErr()) return;
        expect(outage.value[0]?.type).toBe("retryable");
        const rows = await sim.runTasks([
          { name: "read-alice", f: async (task) => await harness.store.getOrb(task, "orb-a") },
          { name: "read-bob", f: async (task) => await harness.store.getOrb(task, "orb-b") },
        ]);
        expect(rows.isOk()).toBe(true);
        if (rows.isErr()) return;
        expect(rows.value[0]?._unsafeUnwrap()?.state).toBe("creating");
        expect(rows.value[1]?._unsafeUnwrap()?.state).toBe("creating");
        expect(harness.deps.control.getAuthBlockedOrbs(A)).toEqual(["orb-a"]);
        expect(harness.deps.control.getAuthBlockedOrbs(B)).toEqual(["orb-b"]);
        expect(harness.deps.control.getChallenge(B)?.userCode).toBe("BOB");
      },
    );
  });

  it("isolates invalid_grant, leases, rotation and exact cleanup by user", async () => {
    await runDst(
      { name: "multi-user-refresh-and-cleanup-isolation", iterations: 40 },
      async (sim) => {
        const pointers = new UserPointerFactory();
        const secrets = new FakeSecretStore();
        const upstreamA = new FakeUpstream("refresh-a");
        const upstreamB = new FakeUpstream("refresh-b");
        const shared = (upstream: FakeUpstream): UserBrokerDeps => ({
          pointers,
          secrets,
          upstreams: { [PROVIDER]: upstream },
          constants: { ...DEFAULT_BROKER_CONSTANTS, minRefreshIntervalMs: 0 },
        });
        const brokerA = bindUserBroker(shared(upstreamA), A);
        const brokerB = bindUserBroker(shared(upstreamB), B);
        const oldA = secrets.seedSecret(PROVIDER, {
          access: "access-a",
          refresh: "refresh-a",
          accountId: "alice",
          expiresAt: 0,
        });
        const oldB = secrets.seedSecret(PROVIDER, {
          access: "access-b",
          refresh: "refresh-b",
          accountId: "bob",
          expiresAt: 0,
        });
        pointers.stores.get(A)?.seedRow({
          provider: PROVIDER,
          rowVersion: 1,
          generation: 1,
          secretVersion: oldA,
          refreshLeaseUntil: 0,
          lastRefreshAt: 0,
        });
        pointers.stores.get(B)?.seedRow({
          provider: PROVIDER,
          rowVersion: 1,
          generation: 1,
          secretVersion: oldB,
          refreshLeaseUntil: 0,
          lastRefreshAt: 0,
        });
        upstreamA.revokeAll();

        const result = await sim.runTasks([
          {
            name: "alice-invalid",
            f: (task) => getToken(task, brokerA, PROVIDER, { reason: "startup" }),
          },
          {
            name: "bob-refresh",
            f: (task) => getToken(task, brokerB, PROVIDER, { reason: "startup" }),
          },
        ]);
        expect(result.isOk()).toBe(true);
        if (result.isErr()) return;
        expect(result.value[0]?._unsafeUnwrapErr().type).toBe("auth_required");
        expect(result.value[1]?._unsafeUnwrap().accountId).toBe("bob");
        expect(pointers.stores.get(A)?.snapshot(PROVIDER)?.secretVersion).toBeNull();
        expect(pointers.stores.get(B)?.snapshot(PROVIDER)?.secretVersion).not.toBeNull();
        expect(secrets.destroyedVersions()).toContain(`${PROVIDER}/${oldB}`);
        expect(secrets.destroyedVersions()).not.toContain(`${PROVIDER}/${oldA}`);
      },
    );
  });
});

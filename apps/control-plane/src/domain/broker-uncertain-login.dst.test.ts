import type { SimulationTask } from "determined";
import { err, errAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FakePointerStore, FakeSecretStore, FakeUpstream } from "../testkit/broker.ts";
import { runDst } from "../testkit/sim.ts";
import { commitLoginCredential, getToken } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import type { PointerConflict, StoreError } from "./errors.ts";
import type {
  BrokerDeps,
  CredentialPointerRow,
  CredentialPointerStore,
  CredentialPointerWrite,
  StoredCredential,
} from "./ports.ts";

const PROVIDER = "openai-codex";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

/**
 * Makes the first CAS land, then withholds its acknowledgement until a second
 * login has superseded it and completed cleanup. The first caller therefore
 * cannot know whether its version was ever published when its CAS reports an
 * outage.
 */
class ExhaustedLoginPointerStore implements CredentialPointerStore {
  private readonly failReads: boolean;

  constructor(failReads: boolean) {
    this.failReads = failReads;
  }

  readPointer(_task: SimulationTask, _provider: string) {
    return this.failReads
      ? errAsync<CredentialPointerRow | null, StoreError>(unavailable("pointer read unavailable"))
      : ResultAsync.fromSafePromise(Promise.resolve<CredentialPointerRow | null>(null));
  }

  casWritePointer(
    _task: SimulationTask,
    _provider: string,
    _expectedRowVersion: number | null,
    _next: CredentialPointerWrite,
  ) {
    return errAsync<CredentialPointerRow, PointerConflict>({ type: "pointer_conflict" });
  }
}

class AmbiguousFirstCommitStore implements CredentialPointerStore {
  private readonly inner = new FakePointerStore();
  private firstCasStarted = false;
  private firstLanded = false;
  secondLoginFinished = false;
  firstVersion: string | null = null;
  secondVersion: string | null = null;

  snapshot(): CredentialPointerRow | null {
    return this.inner.snapshot(PROVIDER);
  }

  readPointer(task: SimulationTask, provider: string) {
    return this.inner.readPointer(task, provider);
  }

  casWritePointer(
    task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict> {
    const first = !this.firstCasStarted;
    if (first) this.firstCasStarted = true;

    const run = async (): Promise<Result<CredentialPointerRow, StoreError | PointerConflict>> => {
      const committed = await this.inner.casWritePointer(task, provider, expectedRowVersion, next);
      if (committed.isErr()) return committed;

      if (first) {
        this.firstVersion = next.secretVersion;
        this.firstLanded = true;
        while (!this.secondLoginFinished) {
          await task.sleep(1, "wait for superseding login cleanup");
        }
        return err(unavailable("first login CAS acknowledgement lost"));
      }

      if (this.firstLanded && this.secondVersion === null) {
        this.secondVersion = next.secretVersion;
      }
      return committed;
    };
    return new ResultAsync(run());
  }

  async waitForFirstCommit(task: SimulationTask): Promise<void> {
    while (!this.firstLanded) await task.sleep(1, "wait for ambiguous login commit");
  }
}

function credential(accountId: string): StoredCredential {
  return {
    access: `access-${accountId}`,
    refresh: `refresh-${accountId}`,
    accountId,
    expiresAt: 2_000_000_000_000,
  };
}

describe("credential broker uncertain login commit (DST)", () => {
  for (const [failure, failReads] of [
    ["pointer reads", true],
    ["definitive CAS conflicts", false],
  ] as const) {
    it(`destroys an unpublished staged version after exhausted ${failure}`, async () => {
      await runDst(
        { name: `broker-login-exhausted-${failReads ? "reads" : "conflicts"}`, iterations: 10 },
        async (sim) => {
          const secrets = new FakeSecretStore();
          const otherVersion = secrets.seedSecret(PROVIDER, credential("other-owner"));
          const otherPointers = new FakePointerStore();
          otherPointers.seedRow({
            provider: PROVIDER,
            rowVersion: 1,
            generation: 1,
            secretVersion: otherVersion,
            refreshLeaseUntil: 0,
            lastRefreshAt: 0,
          });
          const deps: BrokerDeps = {
            pointers: new ExhaustedLoginPointerStore(failReads),
            secrets,
            upstreams: { [PROVIDER]: new FakeUpstream("unused") },
            constants: DEFAULT_BROKER_CONSTANTS,
          };

          const result = await sim.runTasks([
            {
              name: "exhaust-login-publication",
              f: (task) => commitLoginCredential(task, deps, PROVIDER, credential("candidate")),
            },
          ]);
          expect(result.isOk()).toBe(true);
          if (result.isErr()) return;
          expect(result.value[0]?.isErr()).toBe(true);
          expect(secrets.liveVersions(PROVIDER)).toEqual([otherVersion]);
          expect(secrets.destroyedVersions()).not.toContain(`${PROVIDER}/${otherVersion}`);

          const other = await sim.runTasks([
            {
              name: "other-owner-read",
              f: (task) =>
                getToken(task, { ...deps, pointers: otherPointers }, PROVIDER, {
                  reason: "startup",
                }),
            },
          ]);
          expect(other.isOk()).toBe(true);
          if (other.isOk()) expect(other.value[0]?._unsafeUnwrap().accountId).toBe("other-owner");
        },
      );
    });
  }

  it("never republishes a version destroyed after an ambiguous successful CAS", async () => {
    await runDst({ name: "broker-uncertain-login-resurrection", iterations: 20 }, async (sim) => {
      const pointers = new AmbiguousFirstCommitStore();
      const secrets = new FakeSecretStore();
      const deps: BrokerDeps = {
        pointers,
        secrets,
        upstreams: { [PROVIDER]: new FakeUpstream("unused") },
        constants: DEFAULT_BROKER_CONSTANTS,
      };

      const result = await sim.runTasks([
        {
          name: "ambiguous-first-login",
          f: (task) => commitLoginCredential(task, deps, PROVIDER, credential("first")),
        },
        {
          name: "superseding-second-login",
          f: async (task) => {
            await pointers.waitForFirstCommit(task);
            const committed = await commitLoginCredential(
              task,
              deps,
              PROVIDER,
              credential("second"),
            );
            expect(committed.isOk()).toBe(true);
            pointers.secondLoginFinished = true;
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (result.isErr()) return;
      expect(result.value[0]?.isErr()).toBe(true);

      const pointer = pointers.snapshot();
      expect(pointer?.secretVersion).toBe(pointers.secondVersion);
      expect(pointer?.secretVersion).not.toBe(pointers.firstVersion);
      expect(secrets.destroyedVersions()).not.toContain(`${PROVIDER}/${pointers.secondVersion}`);
      expect(pointer?.secretVersion).not.toBeNull();
      if (pointer?.secretVersion === null || pointer?.secretVersion === undefined) return;
      const readable = await sim.runTasks([
        {
          name: "read-published-login",
          f: async (task) =>
            await secrets.readSecret(task, PROVIDER, pointer.secretVersion as string),
        },
      ]);
      expect(readable.isOk(), readable.isErr() ? readable.error.message : "").toBe(true);
      if (readable.isOk()) {
        expect(readable.value[0]?.isOk()).toBe(true);
        expect(readable.value[0]?._unsafeUnwrap()).not.toBeNull();
      }
    });
  });
});

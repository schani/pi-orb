import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostingStore } from "../../domain/hosting-ports.ts";
import type { HostingUploadRequest } from "../../domain/hosting-types.ts";
import type { PostgreSQLClient } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { PostgreSQLControlPlaneStore } from "./store.ts";

const task = new NoSimulationTask("hosting store contract", false);
const PROJECT = "00000000-0000-4000-8000-000000000081";
const ORB = "00000000-0000-4000-8000-000000000082";
const TOKEN = "runtime-token-hash";

export interface HostingStoreContractSubject {
  readonly store: HostingStore;
  setup(): Promise<void>;
  setOrbState(state: "running" | "archiving" | "deleting"): Promise<void>;
  eventTypes(): Promise<string[]>;
  cleanupErrors(): Promise<string[]>;
  assertDeletionGuard(): Promise<void>;
  close(): Promise<void>;
}

export function postgreSQLHostingContractSubject(
  client: PostgreSQLClient,
  store: HostingStore,
  close: () => Promise<void>,
): HostingStoreContractSubject {
  return {
    store,
    setup: async () => {
      expect((await runMigrations(client)).isOk()).toBe(true);
      expect(
        (
          await client.query(
            "INSERT INTO projects (id, name, repository_url) VALUES ($1, $2, $3)",
            [PROJECT, "Hosting", "https://example.test/repository.git"],
          )
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await client.query(
            `INSERT INTO orbs
               (id, project_id, state, host_kind, runtime_token_hash, host_incarnation)
             VALUES ($1, $2, 'running', 'process', $3, 1)`,
            [ORB, PROJECT, TOKEN],
          )
        ).isOk(),
      ).toBe(true);
    },
    setOrbState: async (state) => {
      expect(
        (await client.query("UPDATE orbs SET state = $2 WHERE id = $1", [ORB, state])).isOk(),
      ).toBe(true);
    },
    eventTypes: async () => {
      const result = await client.query(
        "SELECT event_type FROM hosting_events WHERE orb_id = $1 ORDER BY id",
        [ORB],
      );
      return result._unsafeUnwrap().rows.map((row) => String(row["event_type"]));
    },
    cleanupErrors: async () => {
      const result = await client.query(
        "SELECT DISTINCT last_error FROM hosting_cleanup_items WHERE orb_id = $1 AND last_error IS NOT NULL",
        [ORB],
      );
      return result._unsafeUnwrap().rows.map((row) => String(row["last_error"]));
    },
    assertDeletionGuard: async () => {
      const deleted = await new PostgreSQLControlPlaneStore(client).finalizeOrbDeletion(task, {
        orbId: ORB,
        expectedStateVersion: 0,
      });
      expect(deleted.isErr() && deleted.error.type).toBe("state_conflict");
      expect(
        (await client.query("SELECT id FROM orbs WHERE id = $1", [ORB]))._unsafeUnwrap().rows,
      ).toHaveLength(1);
    },
    close,
  };
}

const request = (requestId: string, path = "index.html"): HostingUploadRequest => ({
  orbId: ORB,
  runtimeTokenHash: TOKEN,
  incarnation: 1,
  requestId,
  path,
  size: 5,
  mediaType: "text/html",
  sha256: "a".repeat(64),
});

export function hostingStoreContractTests(
  name: string,
  open: () => Promise<HostingStoreContractSubject>,
): void {
  describe(`${name} hosting store contract`, () => {
    let subject: HostingStoreContractSubject;
    let store: HostingStore;

    beforeEach(async () => {
      subject = await open();
      await subject.setup();
      store = subject.store;
    });

    afterEach(async () => subject.close());

    it("fences reservation with current runtime authority and replays exact request IDs", async () => {
      const first = await store.reserveUpload(task, request("request-a"));
      expect(first.isOk()).toBe(true);
      expect((await store.reserveUpload(task, request("request-a")))._unsafeUnwrap()).toEqual(
        first._unsafeUnwrap(),
      );
      const mismatch = await store.reserveUpload(task, request("request-a", "other.html"));
      expect(mismatch.isErr() && mismatch.error.type).toBe("hosting_conflict");

      await subject.setOrbState("archiving");
      const fenced = await store.reserveUpload(task, request("request-b"));
      expect(fenced.isErr() && fenced.error.type).toBe("hosting_conflict");
    });

    it("claims one upload epoch and rejects a stale worker", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const [left, right] = await Promise.all([
        store.claimUpload(task, {
          operationId: operation.id,
          owner: "worker-a",
          now: 1_000,
          leaseUntil: 2_000,
        }),
        store.claimUpload(task, {
          operationId: operation.id,
          owner: "worker-b",
          now: 1_000,
          leaseUntil: 2_000,
        }),
      ]);
      const outcomes = [left._unsafeUnwrap(), right._unsafeUnwrap()];
      expect(outcomes.filter((outcome) => outcome.type === "claimed")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.type === "busy")).toHaveLength(1);
      const first = outcomes.find((outcome) => outcome.type === "claimed");
      if (first?.type !== "claimed") return;

      expect(
        (
          await store.claimUpload(task, {
            operationId: operation.id,
            owner: "worker-a",
            now: 1_001,
            leaseUntil: 2_001,
          })
        )._unsafeUnwrap(),
      ).toEqual({ type: "busy" });

      const reclaimed = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker-c",
        now: 2_001,
        leaseUntil: 3_000,
      });
      expect(reclaimed.isOk() && reclaimed.value.type).toBe("claimed");
      if (reclaimed.isErr() || reclaimed.value.type !== "claimed") return;
      expect(reclaimed.value.attempt.epoch).toBe(first.attempt.epoch + 1);
      const stale = await store.registerSession(
        task,
        first.attempt.id,
        first.attempt.epoch,
        "stale-session",
      );
      expect(stale.isErr() && stale.error.type).toBe("hosting_conflict");
    });

    it("hands an expired data-capable attempt to a fenced takeover", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const first = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker-a",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(first.isOk() && first.value.type).toBe("claimed");
      if (first.isErr() || first.value.type !== "claimed") return;
      await store.registerSession(
        task,
        first.value.attempt.id,
        first.value.attempt.epoch,
        "partial-session",
      );

      const takeover = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker-b",
        now: 2_001,
        leaseUntil: 3_000,
      });
      expect(takeover.isOk() && takeover.value.type).toBe("claimed");
      if (takeover.isErr() || takeover.value.type !== "claimed") return;
      expect(takeover.value.takeover).toBe(true);
      expect(takeover.value.attempt).toMatchObject({
        id: first.value.attempt.id,
        sessionId: "partial-session",
        epoch: first.value.attempt.epoch + 1,
      });
      expect(
        (
          await store.abandonEmptyAttempt(
            task,
            takeover.value.attempt.id,
            takeover.value.attempt.epoch,
          )
        ).isOk(),
      ).toBe(true);

      const next = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker-c",
        now: 3_001,
        leaseUntil: 4_000,
      });
      expect(next.isOk() && next.value.type).toBe("claimed");
      if (next.isErr() || next.value.type !== "claimed") return;
      expect(next.value.attempt.id).not.toBe(first.value.attempt.id);
      expect(next.value.takeover).toBe(false);
    });

    it("sweeps an expired unpublished attempt into cleanup ownership", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const upload = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "paused-uploader",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(upload.isOk() && upload.value.type).toBe("claimed");
      if (upload.isErr() || upload.value.type !== "claimed") return;

      const cleanup = await store.claimCleanup(task, {
        owner: "cleaner",
        now: 2_001,
        leaseUntil: 3_000,
        limit: 10,
      });
      expect(cleanup._unsafeUnwrap()).toEqual([
        expect.objectContaining({ id: `attempt:${upload.value.attempt.id}`, epoch: 1 }),
      ]);
      const lateSession = await store.registerSession(
        task,
        upload.value.attempt.id,
        upload.value.attempt.epoch,
        "late-session",
      );
      expect(lateSession.isErr() && lateSession.error.type).toBe("hosting_conflict");
    });

    it("does not reclaim an expired registered attempt after cleanup owns it", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const upload = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "paused-uploader",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(upload.isOk() && upload.value.type).toBe("claimed");
      if (upload.isErr() || upload.value.type !== "claimed") return;
      await store.registerSession(
        task,
        upload.value.attempt.id,
        upload.value.attempt.epoch,
        "session",
      );
      await store.claimCleanup(task, {
        owner: "cleaner",
        now: 2_001,
        leaseUntil: 3_000,
        limit: 10,
      });
      expect(
        (
          await store.claimUpload(task, {
            operationId: operation.id,
            owner: "new-uploader",
            now: 2_002,
            leaseUntil: 3_002,
          })
        )._unsafeUnwrap(),
      ).toEqual({ type: "busy" });
    });

    it("publishes one immutable object and retires the replaced generation atomically", async () => {
      const publish = async (requestId: string, generation: string, now: number) => {
        const operation = (await store.reserveUpload(task, request(requestId)))._unsafeUnwrap();
        const claim = await store.claimUpload(task, {
          operationId: operation.id,
          owner: requestId,
          now,
          leaseUntil: now + 1_000,
        });
        const claimed = claim._unsafeUnwrap();
        expect(claimed.type).toBe("claimed");
        const attempt = (claimed as Extract<typeof claimed, { type: "claimed" }>).attempt;
        expect(
          (
            await store.registerSession(task, attempt.id, attempt.epoch, `session-${requestId}`)
          ).isOk(),
        ).toBe(true);
        expect(
          (
            await store.recordCommit(task, attempt.id, attempt.epoch, {
              ref: { key: attempt.objectKey, generation },
              size: 5,
              sha256: "a".repeat(64),
            })
          ).isOk(),
        ).toBe(true);
        return store.publishUpload(task, operation.id, attempt.id, attempt.epoch, now);
      };

      const first = (await publish("request-a", "generation-a", 1_000))._unsafeUnwrap();
      const second = (await publish("request-b", "generation-b", 2_000))._unsafeUnwrap();
      expect((await store.listFiles(task, ORB))._unsafeUnwrap()).toEqual([second]);
      expect(
        (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap().publishedFile,
      ).toEqual(first);
      const cleanup = await store.claimCleanup(task, {
        owner: "cleaner",
        now: 3_000,
        leaseUntil: 4_000,
        limit: 10,
      });
      expect(cleanup._unsafeUnwrap()).toEqual([
        expect.objectContaining({ object: first.object, epoch: 1 }),
      ]);
      expect(await subject.eventTypes()).toEqual(["published", "published"]);
    });

    it("rechecks runtime lifecycle authority when publishing a completed upload", async () => {
      const operation = (await store.reserveUpload(task, request("publish-fence")))._unsafeUnwrap();
      const claimed = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(claimed.isOk() && claimed.value.type).toBe("claimed");
      if (claimed.isErr() || claimed.value.type !== "claimed") return;
      const attempt = claimed.value.attempt;
      await store.registerSession(task, attempt.id, attempt.epoch, "session");
      await store.recordCommit(task, attempt.id, attempt.epoch, {
        ref: { key: attempt.objectKey, generation: "generation" },
        size: 5,
        sha256: "a".repeat(64),
      });
      await subject.setOrbState("archiving");
      const published = await store.publishUpload(
        task,
        operation.id,
        attempt.id,
        attempt.epoch,
        2_000,
      );
      expect(published.isErr() && published.error.type).toBe("hosting_conflict");
      expect((await store.listFiles(task, ORB))._unsafeUnwrap()).toEqual([]);
    });

    it("unpublishes only the observed generation under current runtime authority", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const claim = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "worker",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(claim.isOk() && claim.value.type).toBe("claimed");
      if (claim.isErr() || claim.value.type !== "claimed") return;
      const attempt = claim.value.attempt;
      await store.registerSession(task, attempt.id, attempt.epoch, "session-a");
      await store.recordCommit(task, attempt.id, attempt.epoch, {
        ref: { key: attempt.objectKey, generation: "generation-a" },
        size: 5,
        sha256: "a".repeat(64),
      });
      const file = (
        await store.publishUpload(task, operation.id, attempt.id, attempt.epoch, 1_000)
      )._unsafeUnwrap();
      await subject.setOrbState("archiving");
      const fenced = await store.unpublishExact(
        task,
        { orbId: ORB, runtimeTokenHash: TOKEN, incarnation: 1 },
        file.path,
        file.object,
      );
      expect(fenced.isErr() && fenced.error.type).toBe("hosting_conflict");
      expect((await store.listFiles(task, ORB))._unsafeUnwrap()).toEqual([file]);
      await subject.setOrbState("running");
      expect(
        (
          await store.unpublishExact(
            task,
            { orbId: ORB, runtimeTokenHash: TOKEN, incarnation: 1 },
            file.path,
            file.object,
          )
        ).isOk(),
      ).toBe(true);
      expect((await subject.eventTypes()).filter((event) => event === "removed")).toHaveLength(1);
    });

    it("persists deletion inventory and cleanup claim epochs", async () => {
      const operation = (await store.reserveUpload(task, request("request-a")))._unsafeUnwrap();
      const claim = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "uploader",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(claim.isOk() && claim.value.type).toBe("claimed");
      if (claim.isErr() || claim.value.type !== "claimed") return;
      await store.registerSession(
        task,
        claim.value.attempt.id,
        claim.value.attempt.epoch,
        "session-a",
      );
      await subject.setOrbState("deleting");
      expect((await store.beginOrbCleanup(task, ORB)).isOk()).toBe(true);
      const lateCommit = await store.recordCommit(
        task,
        claim.value.attempt.id,
        claim.value.attempt.epoch,
        {
          ref: { key: claim.value.attempt.objectKey, generation: "late" },
          size: 5,
          sha256: "a".repeat(64),
        },
      );
      expect(lateCommit.isErr() && lateCommit.error.type).toBe("hosting_conflict");

      const first = (
        await store.claimCleanup(task, {
          orbId: ORB,
          owner: "cleaner-a",
          now: 3_000,
          leaseUntil: 4_000,
          limit: 10,
        })
      )._unsafeUnwrap();
      expect(first).toHaveLength(1);
      expect(first).toEqual([expect.objectContaining({ sessionId: "session-a", object: null })]);
      expect(
        (
          await store.claimCleanup(task, {
            orbId: ORB,
            owner: "cleaner-b",
            now: 3_000,
            leaseUntil: 4_000,
            limit: 10,
          })
        )._unsafeUnwrap(),
      ).toEqual([]);
      const item = first[0];
      if (item === undefined) return;
      const discovered = { key: claim.value.attempt.objectKey, generation: "cleanup-generation" };
      expect((await store.recordCleanupObject(task, item.id, item.epoch, discovered)).isOk()).toBe(
        true,
      );
      expect(
        (
          await store.recordCleanupObject(task, item.id, item.epoch, {
            ...discovered,
            generation: "different-generation",
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await store.recordCleanupFailure(task, item.id, item.epoch, "provider busy", 3_500)
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await store.recordCleanupFailure(task, item.id, item.epoch, "provider busy", 3_501)
        ).isOk(),
      ).toBe(true);
      expect(await subject.cleanupErrors()).toEqual(["provider busy"]);
      expect((await store.finishClaimedCleanup(task, item.id, item.epoch - 1)).isErr()).toBe(true);
      expect((await store.finishClaimedCleanup(task, item.id, item.epoch)).isOk()).toBe(true);
      expect((await store.finishOrbCleanup(task, ORB)).isOk()).toBe(true);
    });

    it("blocks permanent orb deletion while hosting inventory remains", async () => {
      expect((await store.reserveUpload(task, request("request-a"))).isOk()).toBe(true);
      await subject.setOrbState("deleting");
      await subject.assertDeletionGuard();
    });

    it("finishes cleanup concurrently with a sweep without reversing lock order", async () => {
      const operation = (await store.reserveUpload(task, request("request-lock")))._unsafeUnwrap();
      const claimed = await store.claimUpload(task, {
        operationId: operation.id,
        owner: "uploader",
        now: 1_000,
        leaseUntil: 2_000,
      });
      expect(claimed.isOk() && claimed.value.type).toBe("claimed");
      if (claimed.isErr() || claimed.value.type !== "claimed") return;
      await store.registerSession(
        task,
        claimed.value.attempt.id,
        claimed.value.attempt.epoch,
        "session-lock",
      );
      await subject.setOrbState("deleting");
      await store.beginOrbCleanup(task, ORB);
      const items = (
        await store.claimCleanup(task, {
          orbId: ORB,
          owner: "finisher",
          now: 3_000,
          leaseUntil: 4_000,
          limit: 10,
        })
      )._unsafeUnwrap();
      const item = items[0];
      expect(item).toBeDefined();
      if (item === undefined) return;
      const [finished, swept] = await Promise.all([
        store.finishClaimedCleanup(task, item.id, item.epoch),
        store.claimCleanup(task, {
          owner: "sweeper",
          now: 3_001,
          leaseUntil: 4_001,
          limit: 10,
        }),
      ]);
      expect(finished.isOk()).toBe(true);
      expect(swept.isOk()).toBe(true);
    });
  });
}

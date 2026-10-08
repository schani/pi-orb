import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
} from "../../../control-plane/src/testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

const content = [{ type: "text" as const, text: "inbox payload" }];
type Envelope = {
  customType: string;
  content: unknown;
  display: boolean;
  details: { messageIds: string[]; operationId: string; delivery: string };
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-abort-dst-"));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const listeners: ((event: AgentSessionEvent) => void)[] = [];
  let idle = true;
  let queued: Envelope | undefined;
  let active: Envelope | undefined;
  let sends = 0;
  let cancellations = 0;
  let failure: "none" | "audit" | "fsync" | "cancel" | "throw" | "send" = "none";
  const emit = (type: "agent_start" | "agent_settled") => {
    for (const listener of listeners) listener({ type } as AgentSessionEvent);
  };
  const session = {
    get isIdle() {
      return idle;
    },
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.push(listener);
      return () => {};
    },
    async sendUserMessage() {
      manager.appendMessage({ role: "user", content, timestamp: 0 });
      idle = false;
      emit("agent_start");
    },
    async sendCustomMessage(envelope: Envelope) {
      if (!idle) {
        queued = envelope;
        return;
      }
      if (failure === "send") {
        failure = "none";
        throw new Error("injected admission cut");
      }
      active = envelope;
      sends++;
      idle = false;
      emit("agent_start");
    },
    cancelQueuedCustomSteer(
      _type: string,
      identity: { operationId: string; messageIds: readonly string[] },
    ) {
      expect(idle).toBe(true);
      expect(
        manager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "pi-orb.inbox-recovery",
          ),
      ).toBe(true);
      if (failure === "throw") throw new Error("injected native boundary failure");
      if (failure === "cancel") return false;
      expect(queued?.details.operationId).toBe(identity.operationId);
      expect(queued?.details.messageIds).toEqual(identity.messageIds);
      queued = undefined;
      cancellations++;
      return true;
    },
    async abort() {},
  } as unknown as PiSession;
  const agent = new PiOrbAgent({
    skillsDir: null,
    orbId: "inbox-dst",
    repositoryUrl: "https://example.com/repo",
    workDir: dir,
    broker: null,
  });
  const summarizer = { summarize: () => okAsync("") };
  agent.attachSession(session, manager, summarizer);
  const sessionFile = manager.getSessionFile();
  manager.getSessionFile = () => (failure === "fsync" ? join(dir, "missing.jsonl") : sessionFile);
  const originalAppend = manager.appendCustomMessageEntry.bind(manager);
  manager.appendCustomMessageEntry = (...args) => {
    if (failure === "audit" && args[0] === "pi-orb.inbox-recovery")
      throw new Error("injected persistence failure");
    return originalAppend(...args);
  };
  return {
    agent,
    manager,
    get queued() {
      return queued;
    },
    get active() {
      return active;
    },
    get sends() {
      return sends;
    },
    get cancellations() {
      return cancellations;
    },
    fail(value: typeof failure) {
      failure = value;
    },
    settle() {
      idle = true;
      emit("agent_settled");
    },
    persist(envelope = active) {
      expect(envelope).toBeDefined();
      if (!envelope) return;
      originalAppend(
        envelope.customType,
        envelope.content as string,
        envelope.display,
        envelope.details,
      );
      active = undefined;
    },
    receipts(id: string) {
      return manager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            (entry.details as { messageIds?: string[] } | undefined)?.messageIds?.includes(id),
        );
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("DST: abort settlement, lost replies, status polling and receipt publication preserve FIFO identity", async () => {
  await runDst({ name: "inbox-abort-recovery", iterations: 80 }, async (sim) => {
    const h = fixture();
    try {
      await h.agent.submitMessage(content, "aborted-operation");
      expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isOk()).toBe(true);
      await h.agent.abortOperation();
      let retriesDone = false;
      let settled = false;
      const run = await sim.runTasks([
        {
          name: "native",
          f: async (task) => {
            await task.checkpoint("abort root drains");
            h.settle();
            settled = true;
            while (!h.active) await task.checkpoint("native waits for fresh CP admission");
            await task.checkpoint("native receipt before reply");
            h.persist();
            await task.checkpoint("native root settles");
            h.settle();
            while (!retriesDone)
              await task.checkpoint("native retains ownership until polling ends");
          },
        },
        ...[0, 1].map((index) => ({
          name: `CP retry ${index}`,
          f: async (task: import("determined").SimulationTask) => {
            for (let pass = 0; pass < 4; pass++) {
              await task.checkpoint("CP polls frozen head after lost response");
              expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isOk()).toBe(
                true,
              );
              h.agent.getHealth();
              expect(h.receipts("head").length).toBeLessThanOrEqual(1);
            }
          },
        })),
        {
          name: "CP final acknowledgement",
          f: async (task) => {
            while (!settled || h.receipts("head").length === 0) {
              await task.checkpoint("CP retries until replication authority");
              expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isOk()).toBe(
                true,
              );
            }
            const ack = await h.agent.deliverInboxMessage("head", ["head"], content);
            expect(ack.isOk() && ack.value.status).toBe("persisted");
            retriesDone = true;
          },
        },
      ]);
      if (run.isErr()) throw run.error;
      expect(h.cancellations).toBe(1);
      expect(h.sends).toBe(1);
      expect(h.receipts("head")).toHaveLength(1);
      expect(h.queued).toBeUndefined();
      const successor = await h.agent.deliverInboxMessage("successor", ["successor"], content);
      expect(successor.isOk() && successor.value.delivery).toBe("turn");
      h.persist();
      h.settle();
      expect(h.receipts("successor")).toHaveLength(1);
    } finally {
      h.dispose();
    }
  });
});

it.each(["audit", "fsync", "cancel", "throw"] as const)(
  "recovery %s cut retains ownership and fences admission",
  async (cut) => {
    const h = fixture();
    try {
      await h.agent.submitMessage(content, "aborted-operation");
      await h.agent.deliverInboxMessage("head", ["head"], content);
      await h.agent.abortOperation();
      h.settle();
      h.fail(cut);
      expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isErr()).toBe(true);
      expect(h.queued).toBeDefined();
      expect(h.sends).toBe(0);
      expect(h.cancellations).toBe(0);
      expect(h.receipts("head")).toHaveLength(0);
      expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isErr()).toBe(true);
    } finally {
      h.dispose();
    }
  },
);

it("admission failure after native cancellation is safe to retry without duplicating the native input", async () => {
  const h = fixture();
  try {
    await h.agent.submitMessage(content, "aborted-operation");
    await h.agent.deliverInboxMessage("head", ["head"], content);
    await h.agent.abortOperation();
    h.settle();
    h.fail("send");
    expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isErr()).toBe(true);
    expect(h.queued).toBeUndefined();
    expect((await h.agent.deliverInboxMessage("head", ["head"], content)).isOk()).toBe(true);
    h.persist();
    h.settle();
    expect(h.cancellations).toBe(1);
    expect(h.sends).toBe(1);
    expect(h.receipts("head")).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it("persisted-first dedup never cancels or starts inference for an acknowledged batch", async () => {
  const h = fixture();
  try {
    await h.agent.submitMessage(content, "aborted-operation");
    await h.agent.deliverInboxMessage("head", ["head"], content);
    h.persist(h.queued);
    await h.agent.abortOperation();
    h.settle();
    const retry = await h.agent.deliverInboxMessage("head", ["head"], content);
    expect(retry.isOk() && retry.value.status).toBe("persisted");
    expect(h.cancellations).toBe(0);
    expect(h.sends).toBe(0);
    expect(h.receipts("head")).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

it("DST: CP delivery notes and recovery replication cannot acknowledge or bypass the frozen FIFO head", async () => {
  await runDst({ name: "inbox-abort-cp-receipts", iterations: 40 }, async (sim) => {
    const h = fixture();
    const cp = makeHarness();
    const orbId = "inbox-dst";
    let auditReplicated = false;
    let delivered = false;
    let peerFailure: unknown;
    const guard =
      (f: (task: import("determined").SimulationTask) => Promise<void>) =>
      async (task: import("determined").SimulationTask) => {
        try {
          await f(task);
        } catch (error) {
          peerFailure = error;
          throw error;
        }
      };
    const check = async (task: import("determined").SimulationTask, name: string) => {
      if (peerFailure !== undefined) throw peerFailure;
      await task.sleep(1, name);
      if (peerFailure !== undefined) throw peerFailure;
    };
    try {
      const run = await sim.runTasks([
        {
          name: "CP delivery",
          f: guard(async (task) => {
            cp.store.seedProject(makeProjectRow("project"));
            cp.store.seedOrb(makeOrbRow(orbId, "project", "running"));
            await h.agent.submitMessage(content, "aborted-operation");
            expect(
              (
                await cp.store.enqueueOrbMessage(task, {
                  orbId,
                  messageId: "head",
                  content,
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            const batch = (
              await cp.store.claimNextOrbMessageBatch(task, { orbId, now: task.wallNow() })
            )._unsafeUnwrap();
            expect(batch.map((row) => row.messageId)).toEqual(["head"]);
            const initial = (
              await h.agent.deliverInboxMessage("head", ["head"], content)
            )._unsafeUnwrap();
            expect(
              (
                await cp.store.noteOrbMessageDelivery(task, {
                  orbId,
                  messageIds: ["head"],
                  delivery: initial.delivery,
                  operationId: initial.operationId,
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            expect(
              (
                await cp.store.enqueueOrbMessage(task, {
                  orbId,
                  messageId: "successor",
                  content,
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            await h.agent.abortOperation();
            h.settle();
            while (!delivered) {
              await check(task, "CP retries frozen head despite queued or persisted responses");
              if (delivered) break;
              const retryBatch = (
                await cp.store.claimNextOrbMessageBatch(task, { orbId, now: task.wallNow() })
              )._unsafeUnwrap();
              if (delivered) break;
              expect(retryBatch.map((row) => row.messageId)).toEqual(["head"]);
              const accepted = (
                await h.agent.deliverInboxMessage("head", ["head"], content)
              )._unsafeUnwrap();
              expect(
                (
                  await cp.store.noteOrbMessageDelivery(task, {
                    orbId,
                    messageIds: ["head"],
                    delivery: accepted.delivery,
                    operationId: accepted.operationId,
                    now: task.wallNow(),
                  })
                ).isOk(),
              ).toBe(true);
            }
          }),
        },
        {
          name: "native consumption",
          f: guard(async (task) => {
            while (!h.active || !auditReplicated)
              await check(task, "native waits at receipt crash cut");
            await check(task, "native consumes once after cancellation");
            h.persist();
            h.settle();
          }),
        },
        {
          name: "CP replication",
          f: guard(async (task) => {
            while (
              !h.manager
                .getEntries()
                .some(
                  (entry) =>
                    entry.type === "custom_message" && entry.customType === "pi-orb.inbox-recovery",
                )
            )
              await check(task, "poller awaits durable recovery intent");
            const auditSnapshot = h.agent.snapshot()._unsafeUnwrap();
            const auditHead = auditSnapshot.records.at(-1)?.id;
            expect(auditHead).toBeDefined();
            if (!auditHead) return;
            expect(
              (
                await cp.store.commitPullBatch(task, {
                  orbId,
                  expectedCursor: null,
                  session: auditSnapshot.session,
                  records: auditSnapshot.records,
                  nextCursor: auditHead,
                  nextHeadId: auditHead,
                })
              ).isOk(),
            ).toBe(true);
            expect(cp.store.messageSnapshots(orbId).map((row) => row.status)).toEqual([
              "delivering",
              "queued",
            ]);
            auditReplicated = true;
            while (h.receipts("head").length === 0)
              await check(task, "poller awaits canonical SDK receipt");
            const receiptSnapshot = h.agent.snapshot()._unsafeUnwrap();
            const receiptHead = receiptSnapshot.records.at(-1)?.id;
            expect(receiptHead).toBeDefined();
            if (!receiptHead) return;
            const after = receiptSnapshot.records.findIndex((record) => record.id === auditHead);
            expect(
              (
                await cp.store.commitPullBatch(task, {
                  orbId,
                  expectedCursor: auditHead,
                  session: receiptSnapshot.session,
                  records: receiptSnapshot.records.slice(after + 1),
                  nextCursor: receiptHead,
                  nextHeadId: receiptHead,
                })
              ).isOk(),
            ).toBe(true);
            expect(cp.store.messageSnapshots(orbId).map((row) => row.status)).toEqual([
              "delivered",
              "queued",
            ]);
            delivered = true;
            const next = (
              await cp.store.claimNextOrbMessageBatch(task, { orbId, now: task.wallNow() })
            )._unsafeUnwrap();
            expect(next.map((row) => row.messageId)).toEqual(["successor"]);
            expect(
              (await h.agent.deliverInboxMessage("successor", ["successor"], content)).isOk(),
            ).toBe(true);
            h.persist();
            h.settle();
            const successorSnapshot = h.agent.snapshot()._unsafeUnwrap();
            const successorHead = successorSnapshot.records.at(-1)?.id;
            if (!successorHead) return;
            const cursor = successorSnapshot.records.findIndex(
              (record) => record.id === receiptHead,
            );
            expect(
              (
                await cp.store.commitPullBatch(task, {
                  orbId,
                  expectedCursor: receiptHead,
                  session: successorSnapshot.session,
                  records: successorSnapshot.records.slice(cursor + 1),
                  nextCursor: successorHead,
                  nextHeadId: successorHead,
                })
              ).isOk(),
            ).toBe(true);
          }),
        },
      ]);
      if (run.isErr()) throw run.error;
      expect(cp.store.messageSnapshots(orbId).map((row) => row.status)).toEqual([
        "delivered",
        "delivered",
      ]);
      const replicaIds = cp.store
        .replicaRecords(orbId)
        .flatMap((record) =>
          record.type === "message" || record.type === "event"
            ? (record.inboxMessageIds ?? [])
            : [],
        );
      expect(replicaIds).toEqual(["head", "successor"]);
      expect(h.receipts("head")).toHaveLength(1);
      expect(h.receipts("successor")).toHaveLength(1);
      expect(h.cancellations).toBe(1);
      expect(h.sends).toBe(2);
    } finally {
      h.dispose();
    }
  });
});

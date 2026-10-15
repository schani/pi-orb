import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { ClaudeHistory } from "../../../orb-runtime/src/claude/history.ts";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../testkit/postgres.ts";

const postgres = process.env.PI_ORB_TEST_DATABASE_URL;
for (const backend of ["PGlite", "PostgreSQL"] as const) {
  it.skipIf(backend === "PostgreSQL" && postgres === undefined)(
    `${backend} commits consumed steering acknowledgement with retained tail from the old replica cursor`,
    async () => {
      const database =
        backend === "PostgreSQL"
          ? (await openThrowawayPostgres(postgres!)).database
          : composeControlPlaneDatabase(new PGliteClient());
      const task = new NoSimulationTask("consumed steering replication", false);
      const dir = mkdtempSync(join(tmpdir(), "claude-receipt-replication-"));
      const timestamp = "2026-10-15T22:23:02.522Z";
      const project = makeProjectRow(randomUUID());
      const orb = makeOrbRow(randomUUID(), project.id, "running", { harness: "claude" });
      const messageId = randomUUID();
      const path = join(dir, "root.jsonl");
      try {
        (await database.migrate())._unsafeUnwrap({ withStackTrace: true });
        (await seedTestUser(task, database.users))._unsafeUnwrap({ withStackTrace: true });
        (await database.store.insertProject(task, project))._unsafeUnwrap({ withStackTrace: true });
        (await database.store.insertOrb(task, orb))._unsafeUnwrap({ withStackTrace: true });
        (
          await database.store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId,
            content: [{ type: "text", text: "steer" }],
            now: 0,
            wake: false,
            cancelSleep: false,
          })
        )._unsafeUnwrap({ withStackTrace: true });
        const history = new ClaudeHistory(dir, "session", timestamp);
        history
          .correlate("input", { messageIds: [messageId], operationId: "operation" })
          ._unsafeUnwrap({ withStackTrace: true });
        const native =
          [
            {
              type: "attachment",
              uuid: "attachment",
              sessionId: "session",
              timestamp,
              attachment: { type: "queued_command", source_uuid: "input", delivery_id: "delivery" },
            },
            {
              type: "queue-operation",
              sessionId: "session",
              operation: "remove",
              reason: "absorbed_mid_turn",
              commandUuid: "input",
              deliveryId: "delivery",
              timestamp,
            },
            {
              type: "assistant",
              uuid: "final",
              timestamp,
              message: { content: "finished", stop_reason: "end_turn" },
            },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n";
        writeFileSync(path, native);
        history.scan(path)._unsafeUnwrap({ withStackTrace: true });
        // Model the existing, fully fingerprinted pre-correction index and partial replica.
        const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
        index.records = index.records.filter(
          (record: HistoryRecord) =>
            record.type !== "event" || record.eventType !== "claude.input_receipt",
        );
        writeFileSync(join(dir, "index.json"), JSON.stringify(index));
        const legacy: HistoryRecord[] = index.records;
        const oldCursor = legacy[1]!.id;
        const session = { id: "session", overflow: {} };
        (
          await database.store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: legacy.slice(0, 2),
            nextCursor: oldCursor,
            nextHeadId: oldCursor,
          })
        )._unsafeUnwrap({ withStackTrace: true });
        const reopened = new ClaudeHistory(dir, "session", "2026-10-16T00:00:00Z");
        const recovered = reopened.scan(path)._unsafeUnwrap({ withStackTrace: true });
        expect(recovered.slice(0, legacy.length)).toEqual(legacy);
        const receipt = reopened.inputReceipt("input")!;
        expect(receipt).toMatchObject({
          type: "event",
          eventType: "claude.input_receipt",
          parentId: "final",
          inboxMessageIds: [messageId],
        });
        const batch = {
          orbId: orb.id,
          expectedCursor: oldCursor,
          session,
          records: recovered.slice(2),
          nextCursor: receipt.id,
          nextHeadId: receipt.id,
        };
        // A failed transaction must acknowledge neither the native final tail nor the receipt.
        expect(
          (
            await database.store.commitPullBatch(task, {
              ...batch,
              records: [...batch.records, { ...receipt, id: oldCursor }],
            })
          ).isErr(),
        ).toBe(true);
        expect(
          (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap({
            withStackTrace: true,
          })[0]?.status,
        ).toBe("queued");
        expect(
          (await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap({
            withStackTrace: true,
          }).cursor,
        ).toBe(oldCursor);
        (await database.store.commitPullBatch(task, batch))._unsafeUnwrap({ withStackTrace: true });
        expect(
          (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap({
            withStackTrace: true,
          })[0]?.status,
        ).toBe("delivered");
        const snapshot = (await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap({
          withStackTrace: true,
        });
        expect(snapshot.records).toEqual(recovered);
        expect(snapshot.cursor).toBe(receipt.id);
        // Lost acknowledgement: reopening and an identical committed batch preserve identity.
        const again = new ClaudeHistory(dir, "session", "2026-10-17T00:00:00Z");
        expect(again.scan(path)._unsafeUnwrap({ withStackTrace: true })).toEqual(recovered);
        (
          await database.store.commitPullBatch(task, { ...batch, expectedCursor: receipt.id })
        )._unsafeUnwrap({ withStackTrace: true });
        expect(
          (await database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap({
            withStackTrace: true,
          }).records,
        ).toEqual(recovered);
        expect(readFileSync(path, "utf8")).toBe(native);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await database.close();
      }
    },
  );
}

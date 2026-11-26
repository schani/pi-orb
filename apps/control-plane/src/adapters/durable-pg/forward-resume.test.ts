import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  type StorageWrite,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { ok } from "neverthrow";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgDurableAuthority } from "./index.ts";

const postgres = process.env.PI_ORB_DURABLE_PG_TEST_URL;

it.each(["pglite", ...(postgres ? ["postgres"] : [])])(
  "%s: resumes interrupted native 1.5.2 generation and tool tasks in place",
  async (backend) => {
    // Only the authority tables are needed; this test does not use public history/search.
    const schema = `forward_resume_${randomUUID().replaceAll("-", "")}`;
    const admin = backend === "postgres" ? new PgClient(postgres!) : undefined;
    const connection = admin ? new URL(postgres!) : undefined;
    connection?.searchParams.set("options", `-c search_path=${schema}`);
    const db = connection ? new PgClient(connection.toString()) : new PGliteClient();
    let harness: Harness | undefined;
    try {
      if (admin) (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
      (
        await db.query(
          "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
        )
      )._unsafeUnwrap();
      for (const name of ["036_durable_authority.sql", "050_durable_sleeping.sql"]) {
        const sql = await readFile(new URL(`../pg/migrations/${name}`, import.meta.url), "utf8");
        (await db.transaction(async (_query, execute) => execute(sql)))._unsafeUnwrap();
      }
      const orb = randomUUID();
      (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
      const authority = new PgDurableAuthority(db, () => 0);
      const owner = (await authority.acquire(orb, "fixture", 0, 0, 1000))._unsafeUnwrap();
      const open = async () =>
        (await authority.open(owner, { project: async () => ok(undefined) }))._unsafeUnwrap();

      // Commit batches captured from unmodified native task code in 1.5.2, at a barrier
      // inside a replay-safe tool, before closing that Harness. No version fields were edited.
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/pi-1.5.2-interrupted.json", import.meta.url), "utf8"),
      ) as { submission: SubmissionId; batches: StorageWrite[][] };
      const seeded = await open();
      expect(await seeded.commit(fixture.batches, () => {}, ctx)).toEqual({
        kind: "stored",
        stored: fixture.batches.length,
      });
      const before = (await seeded.scanTasks({}, 10, undefined, ctx)).items;
      expect(before.map(({ kind, version, state }) => [kind, version, state.status])).toEqual([
        ["pi.generation", 2, "waiting"],
        ["pi.tool", 3, "running"],
      ]);
      await seeded.close(ctx);

      const storage = await open();
      const faux = fauxProvider();
      faux.setResponses([
        (request) => {
          expect(request.messages.filter((msg) => msg.role === "toolResult")).toMatchObject([
            { toolCallId: "prior-call", content: [{ type: "text", text: "recovered tool" }] },
          ]);
          return fauxAssistantMessage("recovered turn");
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const executed: string[] = [];
      registry.install({
        name: "fixture",
        tools: [
          defineTool({
            name: "fixture",
            description: "Fixture tool",
            parameters: Type.Object({}),
            replay: "safe",
            async execute(_args, api) {
              executed.push(api.callId);
              return { output: [{ type: "text", text: "recovered tool" }] };
            },
          }),
        ],
      });
      harness = await Harness.open(
        storage,
        { models, registry, now: () => 2_000_000_000_001 },
        ctx,
      );
      const submission = await harness.submission(fixture.submission, ctx);
      expect(submission).toBeDefined();
      expect(await submission?.wait(ctx)).toMatchObject({ status: "done" });
      expect(executed).toEqual(["prior-call"]);
      const after = (await storage.scanTasks({}, 10, undefined, ctx)).items;
      expect(
        after
          .filter((record) => before.some(({ id }) => record.id === id))
          .map(({ id, version, state }) => [id, version, state]),
      ).toEqual([
        [
          before[0]?.id,
          3,
          expect.objectContaining({
            status: "terminal",
            outcome: expect.objectContaining({ status: "completed" }),
          }),
        ],
        [
          before[1]?.id,
          4,
          expect.objectContaining({
            status: "terminal",
            outcome: expect.objectContaining({ status: "completed" }),
          }),
        ],
      ]);
    } finally {
      await harness?.close(ctx);
      (await db.end())._unsafeUnwrap();
      if (admin) {
        (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  },
);

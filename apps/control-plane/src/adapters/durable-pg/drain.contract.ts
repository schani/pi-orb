import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ok } from "neverthrow";
import { expect, onTestFinished } from "vitest";
import type { PostgreSQLClient } from "../pg/client.ts";
import { initializeBareAuthority } from "./bare-authority.testkit.ts";
import { PgDurableAuthority } from "./index.ts";

export async function assertDrainIsolation(db: PostgreSQLClient) {
  const orb = "00000000-0000-4000-8000-000000000001";
  await initializeBareAuthority(db, orb);
  const authority = new PgDurableAuthority(db, () => 0);
  const owner = (await authority.acquire(orb, "old", 0, 0, 100))._unsafeUnwrap();
  const project = async (query: import("./executor.ts").Query) =>
    (await query("CREATE TABLE IF NOT EXISTS public_terminal(id integer)")).map(() => undefined);
  const storage = (await authority.open(owner, { project }))._unsafeUnwrap();
  onTestFinished(() => storage.close(ctx));
  const undrained = (await authority.open(owner, { project }))._unsafeUnwrap();
  onTestFinished(() => undrained.close(ctx));
  (await db.query("UPDATE orbs SET agent_admission_version=1"))._unsafeUnwrap();
  await expect(storage.commit([], ctx)).rejects.toThrow("admission");
  expect((await authority.beginDrain(owner, storage)).isOk()).toBe(true);
  expect((await authority.validate(owner)).isErr()).toBe(true);
  expect((await authority.ownedTransaction(owner, async () => ok(undefined))).isErr()).toBe(true);
  await expect(undrained.commit([], ctx)).rejects.toThrow("admission");
  await storage.mintId();
  await storage.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], ctx);
  expect((await authority.release(owner)).isOk()).toBe(true);
  expect((await authority.release(owner)).isOk()).toBe(true);
  const successor = (await authority.acquire(orb, "new", 1, 0, 100))._unsafeUnwrap();
  expect((await authority.release(owner)).isErr()).toBe(true);
  expect((await authority.validate(successor)).isOk()).toBe(true);
  await expect(storage.commit([], ctx)).rejects.toThrow("revoked");
  expect((await authority.beginDrain(owner, storage)).isErr()).toBe(true);
  const fresh = (await authority.open(successor, { project }))._unsafeUnwrap();
  onTestFinished(() => fresh.close(ctx));
  (await db.query("UPDATE orbs SET agent_admission_version=2"))._unsafeUnwrap();
  expect((await authority.beginDrain(successor, fresh)).isOk()).toBe(true);
  expect((await authority.archive(successor, async () => ok(undefined))).isOk()).toBe(true);
  expect(
    (await db.query("SELECT * FROM durable_pg_conversations"))._unsafeUnwrap().rows,
  ).toHaveLength(0);
  expect((await db.query("SELECT * FROM public_terminal")).isOk()).toBe(true);
}

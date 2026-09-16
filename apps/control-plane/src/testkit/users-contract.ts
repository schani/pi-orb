import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import type { ControlPlaneDatabase } from "../adapters/database.ts";
import type { PostgreSQLClient } from "../adapters/pg/client.ts";

const task = new NoSimulationTask("users contract", false);

export interface UserStoreContractSubject {
  readonly database: ControlPlaneDatabase;
  readonly client: PostgreSQLClient;
}

export function userStoreContractTests(
  label: string,
  open: () => Promise<UserStoreContractSubject>,
): void {
  describe(`${label} users contract`, () => {
    it("creates no seeded users", async () => {
      const subject = await open();
      try {
        expect((await subject.client.query("SELECT id FROM users"))._unsafeUnwrap().rows).toEqual(
          [],
        );
      } finally {
        await subject.database.close();
      }
    });

    it("atomically keeps one ID when concurrent first logins race and updates email", async () => {
      const { database } = await open();
      try {
        const identity = { issuer: "i", subject: "s", email: "old@example.test" };
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            database.users.resolveUser(task, identity, {
              id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              now: index + 1,
            }),
          ),
        );
        expect(new Set(results.map((result) => result._unsafeUnwrap().id)).size).toBe(1);
        const updated = await database.users.resolveUser(
          task,
          { ...identity, email: "new@example.test" },
          { id: "00000000-0000-4000-8000-000000000099", now: 99 },
        );
        expect(updated._unsafeUnwrap()).toEqual({
          id: results[0]?._unsafeUnwrap().id,
          email: "new@example.test",
        });
      } finally {
        await database.close();
      }
    });

    it("creates distinct users for distinct stable identities", async () => {
      const { database } = await open();
      try {
        const [a, b] = await Promise.all([
          database.users.resolveUser(
            task,
            { issuer: "i", subject: "a", email: null },
            { id: "00000000-0000-4000-8000-000000000001", now: 1 },
          ),
          database.users.resolveUser(
            task,
            { issuer: "i", subject: "b", email: null },
            { id: "00000000-0000-4000-8000-000000000002", now: 1 },
          ),
        ]);
        expect(a._unsafeUnwrap().id).not.toBe(b._unsafeUnwrap().id);
      } finally {
        await database.close();
      }
    });
  });
}

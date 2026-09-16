import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectRow } from "../domain/orb.ts";
import type { ControlPlaneStore } from "../domain/ports.ts";

const task = new NoSimulationTask("owned projects", false);
const A = "00000000-0000-4000-8000-000000000010";
const B = "00000000-0000-4000-8000-000000000020";
const LOWER = "00000000-0000-4000-8000-000000000001";
const row = (id: string, ownerUserId: string, name = "same"): ProjectRow => ({
  id,
  ownerUserId,
  name,
  repositoryUrl: "https://github.com/o/r",
  state: "active",
  stateVersion: 0,
  deletionRequestedAt: null,
  deletionInitialOrbCount: null,
  createdAt: 0,
  updatedAt: 0,
});

export interface OwnedProjectsContractSubject {
  readonly store: ControlPlaneStore;
  seedUser(id: string, subject: string): Promise<void>;
  close(): Promise<void>;
}

export function ownedProjectsContractTests(
  label: string,
  open: () => Promise<OwnedProjectsContractSubject>,
): void {
  describe(`${label} owned projects`, () => {
    let subject: OwnedProjectsContractSubject;
    beforeEach(async () => {
      subject = await open();
      for (const [id, userSubject] of [
        [A, "a"],
        [B, "b"],
      ] as const)
        await subject.seedUser(id, userSubject);
    });
    afterEach(async () => {
      await subject.close();
    });

    it("returns null for malformed and absent project IDs", async () => {
      expect((await subject.store.getProject(task, "missing-project"))._unsafeUnwrap()).toBeNull();
      expect(
        (
          await subject.store.getProject(task, "10000000-0000-4000-8000-000000000099")
        )._unsafeUnwrap(),
      ).toBeNull();
    });

    it("enforces per-owner names and preserves fleet versus owner lists", async () => {
      (
        await subject.store.insertProject(task, row("10000000-0000-4000-8000-000000000001", A))
      )._unsafeUnwrap();
      (
        await subject.store.insertProject(task, row("10000000-0000-4000-8000-000000000002", B))
      )._unsafeUnwrap();
      const conflict = await subject.store.insertProject(
        task,
        row("10000000-0000-4000-8000-000000000003", A),
      );
      expect(
        conflict.isErr() && conflict.error.type === "project_conflict" && conflict.error.reason,
      ).toBe("name_conflict");
      expect((await subject.store.listProjects(task))._unsafeUnwrap()).toHaveLength(2);
      expect((await subject.store.listProjectsByOwner(task, A))._unsafeUnwrap()).toHaveLength(1);
    });

    it("serializes owner-name races and accepts matching same-id retries", async () => {
      const first = row("10000000-0000-4000-8000-000000000001", A);
      const replies = await Promise.all([
        subject.store.insertProject(task, first),
        subject.store.insertProject(task, first),
      ]);
      expect(replies.every((reply) => reply.isOk())).toBe(true);
      const names = await Promise.all([
        subject.store.insertProject(task, row("10000000-0000-4000-8000-000000000002", A, "race")),
        subject.store.insertProject(task, row("10000000-0000-4000-8000-000000000003", A, "race")),
      ]);
      expect(names.filter((reply) => reply.isOk())).toHaveLength(1);
      expect(
        names.some(
          (reply) =>
            reply.isErr() &&
            reply.error.type === "project_conflict" &&
            reply.error.reason === "name_conflict",
        ),
      ).toBe(true);
    });

    it("types a cross-owner same-id race while a lower UUID user is inserted", async () => {
      const id = "10000000-0000-4000-8000-000000000004";
      const [left, right] = await Promise.all([
        subject.store.insertProject(task, row(id, A, "owner-a")),
        subject.store.insertProject(task, row(id, B, "owner-b")),
        subject.seedUser(LOWER, "lower"),
      ]);
      expect([left, right].filter((reply) => reply.isOk())).toHaveLength(1);
      expect(
        [left, right].some(
          (reply) =>
            reply.isErr() &&
            reply.error.type === "project_conflict" &&
            reply.error.reason === "concurrent_change",
        ),
      ).toBe(true);
    });

    it("returns typed rename conflicts and fences retries after deletion", async () => {
      const one = row("10000000-0000-4000-8000-000000000001", A, "one");
      const two = row("10000000-0000-4000-8000-000000000002", A, "two");
      (await subject.store.insertProject(task, one))._unsafeUnwrap();
      (await subject.store.insertProject(task, two))._unsafeUnwrap();
      const rename = await subject.store.updateProject(task, {
        projectId: two.id,
        name: "one",
        repositoryUrl: two.repositoryUrl,
        now: 1,
      });
      expect(
        rename.isErr() && rename.error.type === "project_conflict" && rename.error.reason,
      ).toBe("name_conflict");
      (
        await subject.store.requestProjectDeletion(task, {
          projectId: one.id,
          now: 2,
          cleanupAfter: 3,
        })
      )._unsafeUnwrap();
      const retry = await subject.store.insertProject(task, one);
      expect(retry.isErr() && retry.error.type === "project_conflict" && retry.error.reason).toBe(
        "concurrent_change",
      );
    });
  });
}

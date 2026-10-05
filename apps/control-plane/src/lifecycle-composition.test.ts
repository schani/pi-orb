import { readFileSync } from "node:fs";
import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { readMaintenanceInput, runMaintenance } from "./maintenance.ts";
import { makeHarness, seedRunningOrb } from "./testkit/fixtures.ts";

describe("headless maintenance", () => {
  it("has no HTTP, user-auth or autonomous-loop composition", () => {
    for (const path of ["maintenance.ts", "lifecycle-composition.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /from ["'].*(?:main|http\/|google-application-auth|domain\/loops)\./,
      );
      expect(source).not.toContain("Fastify");
      expect(source).not.toContain(".listen(");
    }
  });
  it("seals before safe stdout, omitting history and closing its owned store", async () => {
    const task = new NoSimulationTask("fixture", false);
    const h = makeHarness();
    seedRunningOrb(task, h, "fake-orb");
    const events: string[] = [];
    const result = await runMaintenance(
      ["inventory", "--release-id", "fake", "--phase", "before"],
      {
        DATABASE_URL: "postgres://fake",
        PI_ORB_HOSTING_BUCKET: "private-fake",
        PI_ORB_MAINTENANCE_EXECUTION_ID: "fake-execution",
        PI_ORB_MAINTENANCE_SOURCE_SHA: "a".repeat(40),
      },
      {
        task,
        compose: async () =>
          ok({
            deps: h.deps,
            close: async () => {
              events.push("closed");
              return ok(undefined);
            },
          }),
        receipts: () => ({
          read: async () => err({ type: "maintenance_error", code: "storage" }),
          seal: async (_key, snapshot) => {
            expect(JSON.stringify(snapshot)).not.toContain("content");
            events.push("sealed");
            return ok({
              receiptUri: "gs://private-fake/result",
              generation: "1",
              sha256: "a".repeat(64),
            });
          },
        }),
        stdout: (line) => {
          events.push("stdout");
          expect(Object.keys(JSON.parse(line)).sort()).toEqual(
            [
              "mode",
              "phase",
              "releaseId",
              "executionId",
              "receiptUri",
              "generation",
              "sha256",
              "counts",
              "outcome",
            ].sort(),
          );
          expect(line).not.toContain("fake-orb");
        },
      },
    );
    expect(result.isOk()).toBe(true);
    expect(events).toEqual(["sealed", "closed", "stdout"]);
  });
  it("rejects incomplete or unsafe modes before composing any resources", async () => {
    let composed = false;
    const outcome = await runMaintenance(
      [],
      {},
      {
        compose: async () => {
          composed = true;
          return err({ type: "maintenance_error", code: "invalid" });
        },
        stdout: () => {
          throw new Error("unexpected stdout");
        },
      },
    );
    expect(outcome.isErr()).toBe(true);
    expect(composed).toBe(false);
    expect(
      readMaintenanceInput(["resume", "--release-id", "fake", "--phase", "final"], {}).isErr(),
    ).toBe(true);
  });
  it("closes an owned composition when receipt input fails, without acknowledging", async () => {
    let closed = 0;
    const result = await runMaintenance(
      [
        "inventory",
        "--release-id",
        "fake",
        "--phase",
        "final",
        "--snapshot-uri",
        "gs://private-fake/release-maintenance/fake/drain/old.json",
        "--snapshot-generation",
        "1",
        "--snapshot-sha256",
        "a".repeat(64),
      ],
      {
        DATABASE_URL: "postgres://fake",
        PI_ORB_HOSTING_BUCKET: "private-fake",
        PI_ORB_MAINTENANCE_EXECUTION_ID: "fake-execution",
        PI_ORB_MAINTENANCE_SOURCE_SHA: "a".repeat(40),
      },
      {
        compose: async () =>
          ok({
            deps: {} as never,
            close: async () => {
              closed++;
              return ok(undefined);
            },
          }),
        receipts: () => ({
          read: async () => err({ type: "maintenance_error", code: "storage" }),
          seal: async () => err({ type: "maintenance_error", code: "storage" }),
        }),
        stdout: () => {
          throw new Error("unexpected success");
        },
      },
    );
    expect(result.isErr()).toBe(true);
    expect(closed).toBe(1);
  });
});

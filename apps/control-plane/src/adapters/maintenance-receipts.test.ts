import { describe, expect, it } from "vitest";
import { createMaintenanceReceipts } from "./maintenance-receipts.ts";

const binding = {
  releaseId: "release-fake",
  executionId: "execution-fake",
  sourceSha: "a".repeat(40),
  mode: "inventory" as const,
  phase: "before" as const,
};
const snapshot = {
  releaseId: binding.releaseId,
  phase: "before",
  projects: [],
  orbs: [],
  resumeCandidates: [],
};
describe("private maintenance receipts", () => {
  it("verifies exact generation, hash, release and source before using a snapshot", async () => {
    const finalBinding = { ...binding, phase: "final" as const };
    const finalSnapshot = { ...snapshot, phase: "final" };
    let body = "";
    const writer = createMaintenanceReceipts({
      bucket: "private-fake",
      binding: finalBinding,
      auth: { getAccessToken: async () => "token" },
      fetch: async (_url, init) => {
        body = String(init?.body);
        return new Response(JSON.stringify({ generation: "2" }));
      },
    });
    const reference = (await writer.seal("result", finalSnapshot))._unsafeUnwrap();
    const reader = createMaintenanceReceipts({
      bucket: "private-fake",
      binding,
      auth: { getAccessToken: async () => "token" },
      fetch: async (url) => {
        expect(String(url)).toContain("generation=2");
        return new Response(body);
      },
    });
    expect((await reader.read(reference, "final"))._unsafeUnwrap()).toEqual(finalSnapshot);
    expect((await reader.read({ ...reference, sha256: "b".repeat(64) }, "final")).isErr()).toBe(
      true,
    );
    const foreign = createMaintenanceReceipts({
      bucket: "private-fake",
      binding: { ...binding, sourceSha: "b".repeat(40) },
      auth: { getAccessToken: async () => "token" },
      fetch: async () => new Response(body),
    });
    expect((await foreign.read(reference, "final")).isErr()).toBe(true);
  });

  it("uses create-only objects and emits no content outside the explicit schema", async () => {
    let body = "";
    const receipts = createMaintenanceReceipts({
      bucket: "private-fake",
      binding,
      auth: { getAccessToken: async () => "secret-token" },
      fetch: async (url, init) => {
        expect(String(url)).toContain("ifGenerationMatch=0");
        body = String(init?.body);
        return new Response(JSON.stringify({ generation: "123" }), { status: 200 });
      },
    });
    const sealed = await receipts.seal("result", {
      ...snapshot,
      content: "private-history",
    } as typeof snapshot);
    expect(sealed.isOk()).toBe(true);
    expect(body).not.toContain("private-history");
    expect(body).not.toContain("secret-token");
    expect(sealed._unsafeUnwrap().receiptUri).toBe(
      "gs://private-fake/release-maintenance/release-fake/before/execution-fake.json",
    );
  });
  it("maps raw SDK rejection and conflicts to payload-free typed errors without retry", async () => {
    for (const request of [
      async () => {
        throw new Error("credential-payload");
      },
      async () => new Response("private-payload", { status: 412 }),
    ]) {
      const receipts = createMaintenanceReceipts({
        bucket: "private-fake",
        binding,
        auth: { getAccessToken: async () => "token" },
        fetch: request,
      });
      expect(await receipts.seal("result", snapshot)).toMatchObject({
        error: { type: "maintenance_error", code: "storage" },
      });
    }
  });
  it("rejects foreign receipt URIs before requesting credentials", async () => {
    const receipts = createMaintenanceReceipts({
      bucket: "private-fake",
      binding,
      auth: {
        getAccessToken: async () => {
          throw new Error("must not run");
        },
      },
    });
    const result = await receipts.read(
      { receiptUri: "gs://other/file", generation: "1", sha256: "a".repeat(64) },
      "final",
    );
    expect(result.isErr()).toBe(true);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { registerUploadRoutes } from "../../../orb-runtime/src/uploads/routes.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { registerWorkspaceUploadRoutes } from "./workspace-upload-routes.ts";

it("streams browser → control plane → runtime, publishes binary bytes, and queues once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orb-upload-http-"));
  const runtime = Fastify();
  const app = Fastify();
  const task = new NoSimulationTask("upload HTTP", false);
  const h = makeHarness();
  const orbId = "00000000-0000-4000-8000-000000000001";
  const spec = {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "input.bin",
    size: 96 * 1024 + 3,
  };
  try {
    await registerUploadRoutes(runtime, { workDir: dir, incarnation: "0", ready: () => true });
    const base = await runtime.listen({ port: 0, host: "127.0.0.1" });
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow(orbId, "project", "running", { hostRef: "host" }));
    vi.spyOn(h.deps.hostProvider, "observe").mockImplementation(() =>
      okAsync({
        ref: { provider: "process", resourceId: "host" },
        orbId,
        incarnation: 0,
        specFingerprint: null,
        state: "running" as const,
        runtimeAddress: { baseUrl: base },
      }),
    );
    registerWorkspaceUploadRoutes(app, task, h.deps);
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const endpoint = `${url}/api/v1/orbs/${orbId}/uploads`;
    const second = { id: "b0000000-0000-4000-8000-000000000002", name: "empty.bin", size: 0 };
    const batch = { id: spec.id, files: [spec, second] };
    const admitted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    expect(admitted.status).toBe(200);
    let pulls = 0;
    const bytes = Buffer.alloc(spec.size, 0xa7);
    bytes[0] = 0;
    bytes[spec.size - 1] = 0xff;
    const body = Readable.from(
      (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          pulls++;
          yield bytes.subarray(offset, offset + 1024);
        }
      })(),
    );
    const uploaded = await fetch(`${endpoint}/${spec.id}/chunk?offset=0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(spec.size) },
      body: Readable.toWeb(body) as never,
      duplex: "half",
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);
    expect(pulls).toBeGreaterThan(1);
    const status = await fetch(`${endpoint}/${spec.id}/status`);
    expect(((await status.json()) as { offset: number }).offset).toBe(spec.size);
    const finished = await fetch(`${endpoint}/${spec.id}/finish`, { method: "POST" });
    expect(finished.status).toBe(200);
    const row = (await finished.json()) as { path: string; status: string };
    expect(row.status).toBe("stored");
    expect(h.store.messageSnapshots(orbId)).toHaveLength(0);
    expect(await readFile(row.path)).toEqual(bytes);
    const secondFinished = await fetch(`${endpoint}/${second.id}/finish`, { method: "POST" });
    expect(secondFinished.status).toBe(200);
    const secondRow = (await secondFinished.json()) as { path: string; status: string };
    expect(secondRow.status).toBe("notified");
    expect((await fetch(`${endpoint}/${spec.id}/finish`, { method: "POST" })).status).toBe(200);
    expect(h.store.messageSnapshots(orbId)).toHaveLength(1);
    expect(h.store.messageSnapshots(orbId)[0]?.content).toEqual([
      {
        type: "text",
        text: `The user uploaded files:\n- ${JSON.stringify(row.path)} (${spec.size} bytes)\n- ${JSON.stringify(secondRow.path)} (0 bytes)`,
      },
    ]);
    const current = h.store.orbSnapshot(orbId);
    assert(current !== null);
    h.store.seedOrb({ ...current, state: "stopped" });
    const denied = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...batch, id: "c0000000-0000-4000-8000-000000000003" }),
    });
    expect(denied.status).toBe(409);
    const bad = await fetch(
      `${base}/v1/uploads/${spec.id}/status?name=input.bin&size=${spec.size}`,
      { headers: { "x-orb-incarnation": "1" } },
    );
    expect(bad.status).toBe(409);
  } finally {
    await app.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

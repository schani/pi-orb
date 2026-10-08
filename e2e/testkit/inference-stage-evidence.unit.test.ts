import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureSubagentFailure } from "./subagent-failure-evidence.ts";

it("retains only content-free inference stages in the bounded root tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "inference-evidence-"));
  const orb = "c01e5202-cc89-468e-9b96-0123456789ab";
  const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "root.jsonl"),
    JSON.stringify({
      type: "custom",
      customType: "pi-orb.inference-stage",
      data: {
        operationId: orb,
        sessionId: orb,
        sequence: 6,
        observedAt: 123,
        stage: "provider_preparation",
        edge: "enter",
        error: "SECRET",
        prompt: "SECRET",
      },
    }),
  );
  const artifact = join(root, "failure.json");
  const unavailable = async () => ({ status: 503, body: {} });
  try {
    const saved = await captureSubagentFailure({
      root,
      orb,
      artifact,
      phase: "continuation",
      logs: [],
      probes: {
        health: unavailable,
        orb: unavailable,
        history: unavailable,
        model: unavailable,
        names: unavailable,
      },
    });
    expect(saved.isOk()).toBe(true);
    const text = readFileSync(artifact, "utf8");
    expect(JSON.parse(text).root.entries[0]).toMatchObject({
      customType: "pi-orb.inference-stage",
      inference: {
        operationId: orb,
        sessionId: orb,
        sequence: 6,
        observedAt: 123,
        stage: "provider_preparation",
        edge: "enter",
      },
    });
    expect(text).not.toContain("SECRET");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

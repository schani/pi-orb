import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect as expectPage, type Page } from "@playwright/test";
import { expect } from "vitest";
import {
  api,
  type ControlPlaneHandle,
  effectiveOpenAIResponseInstructions,
  readReplicatedHistorySnapshot,
  startControlPlane,
  waitFor,
} from "../harness.ts";
import { onlyCodemodeCatalog, requestedTools } from "./durable-model-fixture.ts";
import { appendModelStage } from "./durable-stage-rules.ts";

export const artifactCreateSource =
  '// @options: {"max_output_tokens":128}\ntext(Array.from({length:200}, (_, i) => i === 119 ? "RETAINED_PRIVATE_SPILL_MARKER" : "PRIVATE_SPILL_FILLER_" + "x".repeat(512)).join("\\n"));';

export function artifactReadSource(path: string): string {
  return `text('ARTIFACT_READ:' + await tools.read({path:${JSON.stringify(path)}, offset:120, limit:1})); text('RESTORED_SKILL:' + await tools.read({path:'.agents/skills/pinned/asset.txt'}));`;
}

const stop = { type: "stop", status: "completed" };
const summary = {
  match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
  steps: [{ type: "text", content: "Private artifact retained." }, stop],
};

type RestartFixture = {
  cp: ControlPlaneHandle;
  cpOptions: Parameters<typeof startControlPlane>[0];
  browser: Browser;
  page: Page;
  orb: string;
  evidence: string;
  privatePolicy: string;
  fake: { sessionKey: string };
  submit(text: string): Promise<void>;
  priorRequests: Record<string, unknown>[];
  priorLogs: string[];
  restart(next: ControlPlaneHandle): void;
  setPage(next: Page | undefined): void;
  disableResources(): void;
  resourceAcquisitions(): number;
  released(): boolean;
  release(): void;
};

export async function runArtifactRestart(f: RestartFixture): Promise<void> {
  const thinking = f.page.getByRole("button", { name: "Change thinking", exact: true });
  await thinking.click();
  await f.page.getByRole("option", { name: "low", exact: true }).click();
  await expectPage(thinking).toHaveText("low");
  await appendModelStage(f.fake.sessionKey, [
    {
      match: { userMessage: { regex: "^CREATE_PRIVATE_SPILL$" } },
      steps: [
        { type: "toolCall", name: "codemode", arguments: { code: artifactCreateSource } },
        stop,
      ],
    },
    {
      match: { toolResultContains: { regex: "/orb-artifacts/" } },
      steps: [{ type: "text", content: "PRIVATE_SPILL_CREATED" }, stop],
    },
    summary,
  ]);
  await f.submit("CREATE_PRIVATE_SPILL");
  await expectPage(f.page.getByText("PRIVATE_SPILL_CREATED", { exact: true })).toBeVisible();
  await waitFor("spill summary settled before graceful CP restart", async () =>
    f.cp.logs.join("").split("harness.summary_completed").length >= 3 ? true : null,
  );
  const history = await readReplicatedHistorySnapshot(f.cp, f.orb);
  const serialized = JSON.stringify(history);
  const path = serialized.match(/\/orb-artifacts\/[0-9a-f-]{36}/)?.[0];
  expect(path).toBeDefined();
  const records = history.records;
  const spilled = records.find(
    (record) =>
      JSON.stringify(record).includes(path!) &&
      JSON.stringify(record).includes("PRIVATE_SPILL_FILLER_"),
  );
  expect(spilled).toBeDefined();
  // Includes projection metadata, not only the excerpt. The full ~106KiB
  // output cannot be hidden in overflow.native or another public field.
  expect(JSON.stringify(spilled).length).toBeLessThan(16_384);
  expect(serialized).not.toContain("x".repeat(1024));
  writeFileSync(join(f.evidence, "spill-history.json"), serialized);
  await f.page.close();
  f.setPage(undefined);
  f.priorRequests.push(...(f.cp.modelRequests ?? []));
  await f.cp.stop();
  f.priorLogs.push(...f.cp.logs);
  f.disableResources();
  await appendModelStage(f.fake.sessionKey, [
    {
      match: { userMessage: { regex: "^READ_RETAINED_SPILL$" } },
      steps: [
        { type: "toolCall", name: "codemode", arguments: { code: artifactReadSource(path!) } },
        stop,
      ],
    },
    {
      match: { toolResultContains: { regex: "ARTIFACT_READ:RETAINED_PRIVATE_SPILL_MARKER" } },
      steps: [{ type: "text", content: "RETAINED_SPILL_READ_DONE" }, stop],
    },
    summary,
  ]);
  // Same port, DB, auth, hosting and host-state paths; only this test's CP.
  const cp = await startControlPlane(f.cpOptions);
  f.restart(cp);
  const page = await f.browser.newPage();
  f.setPage(page);
  await page.goto(`${cp.baseUrl}/orbs/${f.orb}`);
  await expectPage(page.getByRole("button", { name: "Change thinking", exact: true })).toHaveText(
    "low",
  );
  await f.submit("READ_RETAINED_SPILL");
  await expectPage(page.getByText("RETAINED_SPILL_READ_DONE", { exact: true })).toBeVisible();
  const restored = JSON.stringify(await readReplicatedHistorySnapshot(cp, f.orb));
  expect(restored).toContain("RESTORED_SKILL:PINNED_RESOURCE_ASSET");
  expect(f.resourceAcquisitions()).toBe(1);
  expect(f.released()).toBe(false);
  expect((await api(cp.baseUrl, "GET", `/api/v1/orbs/${f.orb}`)).body["state"]).not.toBe("running");
  const requests = cp.modelRequests ?? [];
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.filter((request) => requestedTools(request).length > 0).every(onlyCodemodeCatalog),
  ).toBe(true);
  expect(
    requests.some((request) =>
      effectiveOpenAIResponseInstructions(request).includes(f.privatePolicy),
    ),
  ).toBe(true);
  expect(requests.some((request) => JSON.stringify(request).includes("x".repeat(1024)))).toBe(
    false,
  );
  const catalogs = [...f.priorRequests, ...requests].filter(
    (request) => requestedTools(request).length > 0,
  );
  expect(catalogs.every(onlyCodemodeCatalog)).toBe(true);
  f.release();
}

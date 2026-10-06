import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { agentBackend } from "./agent-backend.ts";

it("keeps cloud deployment explicitly on host Pi until adoption is approved", async () => {
  const config = await readFile(new URL("../../../infra/run.tf", import.meta.url), "utf8");
  expect(config).toMatch(/PI_ORB_AGENT_BACKEND\s*=\s*"host-pi"/);
});
it("selects placement independently of the host provider", () => {
  expect(agentBackend(undefined)._unsafeUnwrap()).toBe("central-durable");
  expect(agentBackend("central-durable")._unsafeUnwrap()).toBe("central-durable");
  expect(agentBackend("host-pi")._unsafeUnwrap()).toBe("host-pi");
  expect(agentBackend("process").isErr()).toBe(true);
});

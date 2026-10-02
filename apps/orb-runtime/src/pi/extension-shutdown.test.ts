import { expect, it } from "vitest";
import { PiOrbAgent } from "./agent.ts";

it("awaits extension shutdown once for concurrent and repeated runtime closure", async () => {
  const agent = new PiOrbAgent({
    orbId: "shutdown-test",
    repositoryUrl: "https://example.com/repo.git",
    workDir: "/tmp/shutdown-test",
    skillsDir: null,
    broker: null,
  });
  let release!: () => void;
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  (agent as unknown as { shutdownExtensions: () => Promise<void> }).shutdownExtensions = () => {
    calls++;
    return drained;
  };
  const first = agent.closeExtensions();
  const second = agent.closeExtensions();
  expect(first).toBe(second);
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second, agent.closeExtensions()]);
  expect(calls).toBe(1);
});

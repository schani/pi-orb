import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { RuntimePreviewService } from "./preview.ts";

it("Claude idle-stop preparation closes preview admission", async () => {
  const fixture = new ComposedClaudeFixture();
  try {
    expect((await fixture.attach()).isOk()).toBe(true);
    const service = new RuntimePreviewService({
      agent: fixture.agent,
      orbId: "orb",
      reservedPorts: () => [8080],
      verifier: {
        verify: () =>
          ok({
            v: 1,
            origin: "https://preview.example",
            expiresAt: 10000,
            target: {
              orbId: "orb",
              port: 3000,
              registrationId: "generation",
              executionId: "execution",
              incarnation: 0,
              runtimeInstanceId: fixture.agent.runtimeInstanceId,
            },
          }),
      },
    });
    expect(fixture.agent.prepareIdleStop().isOk()).toBe(true);
    expect(service.admit("grant", 3000, "http")._unsafeUnwrapErr().code).toBe("orb_unavailable");
  } finally {
    await fixture.agent.closeExtensions();
    fixture.dispose();
  }
});

it("Claude rejects idle preparation for active HTTP without reporting agent busy", async () => {
  const fixture = new ComposedClaudeFixture();
  try {
    expect((await fixture.attach()).isOk()).toBe(true);
    const lease = fixture.agent.previewActivity.acquire("http");
    expect(fixture.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(fixture.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
    lease.release();
    fixture.agent.shutdownHooks();
    expect(fixture.agent.gateView().acceptingWork).toBe(false);
  } finally {
    await fixture.agent.closeExtensions();
    fixture.dispose();
  }
});

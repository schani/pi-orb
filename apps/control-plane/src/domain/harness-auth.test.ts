import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce } from "./lifecycle.ts";
import type { AuthGate } from "./ports.ts";

const task = new NoSimulationTask("harness auth", false);
const piChallenge = {
  provider: "openai-codex" as const,
  verificationUri: "https://example.com",
  userCode: "code",
  expiresAt: Date.now() + 60_000,
};
const claudeChallenge = {
  provider: "claude" as const,
  verificationUri: "",
  userCode: "",
  expiresAt: Date.now() + 60_000,
};

describe("harness authentication", () => {
  it("keeps same-owner provider challenges independent", () => {
    const control = new ControlState();
    control.markAuthBlocked("pi", "owner", "openai-codex");
    control.markAuthBlocked("claude", "owner", "claude");
    control.setChallenge("owner", piChallenge);
    control.setChallenge("owner", claudeChallenge);
    expect(control.getAuthBlock("pi")?.challenge).toEqual(piChallenge);
    expect(control.getAuthBlock("claude")?.challenge).toEqual(claudeChallenge);
    control.setChallenge("owner", null, "claude");
    expect(control.getAuthBlock("pi")?.challenge).toEqual(piChallenge);
    expect(control.getAuthBlock("claude")?.challenge).toBeNull();
  });

  it("fails only the selected provider cohort", async () => {
    const harness = makeHarness();
    const project = makeProjectRow("project");
    harness.store.seedProject(project);
    for (const kind of ["pi", "claude"] as const) {
      harness.store.seedOrb(
        makeOrbRow(kind, project.id, "creating", { harness: kind, stateChangedAt: task.wallNow() }),
      );
      harness.deps.control.markAuthBlocked(
        kind,
        project.ownerUserId,
        kind === "pi" ? "openai-codex" : "claude",
      );
    }
    harness.deps.control.setChallenge(project.ownerUserId, piChallenge);
    harness.deps.control.setChallenge(project.ownerUserId, claudeChallenge);
    const gate: AuthGate = {
      ensureAuth: () =>
        okAsync({ status: "failed", message: "Claude connection failed", retryable: false }),
    };
    await reconcileOrbOnce(task, { ...harness.deps, authGate: gate }, "claude");
    expect(harness.store.orbSnapshot("claude")?.state).toBe("failed");
    expect(harness.store.orbSnapshot("pi")?.state).toBe("creating");
    expect(harness.deps.control.getAuthBlock("pi")?.challenge).toEqual(piChallenge);
  });

  it("uses the project owner and selected harness without requiring Codex", async () => {
    const harness = makeHarness();
    const project = makeProjectRow("project");
    harness.store.seedProject(project);
    harness.store.seedOrb(
      makeOrbRow("claude", project.id, "creating", {
        harness: "claude",
        stateChangedAt: task.wallNow(),
      }),
    );
    const calls: unknown[] = [];
    const gate: AuthGate = {
      ensureAuth: (_task, owner, kind) => {
        calls.push([owner, kind]);
        return okAsync({ status: "pending", challenge: claudeChallenge });
      },
    };
    await reconcileOrbOnce(task, { ...harness.deps, authGate: gate }, "claude");
    expect(calls).toEqual([[project.ownerUserId, "claude"]]);
    expect(harness.deps.control.getAuthBlock("claude")?.challenge?.provider).toBe("claude");
  });
});

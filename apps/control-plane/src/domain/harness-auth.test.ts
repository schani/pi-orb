import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createSpawnModelCheck } from "../adapters/spawn-models.ts";
import { FakePointerStore, FakeSecretStore } from "../testkit/broker.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER, ClaudeSubscriptionAuth } from "./claude-auth.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce } from "./lifecycle.ts";
import type { AuthGate, StoredSecret } from "./ports.ts";

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

const sdk = vi.hoisted(() => ({ query: vi.fn(), supportedModels: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

it.each([
  ["claude", "opus", "available", null],
  ["claude", "missing", "available", "invalid"],
  ["claude", "opus", "disconnected", "disconnected"],
  ["claude", "opus", "lookup", "unavailable"],
  ["claude", "opus", "query", "unavailable"],
  ["claude", "opus", "close", "unavailable"],
  ["openai-codex", "gpt-6.1-sol", "available", null],
  ["openai-codex", "missing", "available", "invalid"],
  ["openai-codex", "gpt-6.1-sol", "wrong-secret", "unavailable"],
  ["openai-codex", "gpt-6.1-sol", "disconnected", "disconnected"],
] as const)("spawn checks only owner provider %s/%s (%s)", async (provider, id, mode, reason) => {
  sdk.query.mockReset().mockImplementation(() => {
    if (mode === "query") throw new Error("private");
    return sdk;
  });
  sdk.close.mockReset().mockImplementation(() => {
    if (mode === "close") throw new Error("private");
  });
  sdk.supportedModels.mockReset().mockImplementation(async () => {
    if (mode === "lookup") throw new Error("private");
    return [{ value: "opus", displayName: "Opus", description: "" }];
  });
  const pointers = new FakePointerStore(),
    secrets = new FakeSecretStore();
  const slot = provider === "claude" ? CLAUDE_SUBSCRIPTION_PROVIDER : provider;
  const secret: StoredSecret =
    provider === "claude" || mode === "wrong-secret"
      ? { kind: "claude_subscription", token: "owner-token", createdAt: 0 }
      : { access: "a", refresh: "r", accountId: "owner", expiresAt: task.wallNow() + 3600000 };
  if (mode !== "disconnected")
    pointers.seedRow({
      provider: slot,
      rowVersion: 1,
      generation: 1,
      secretVersion: secrets.seedSecret(slot, secret),
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
  const forUser = vi.fn((_owner: string) => pointers);
  const auth = new ClaudeSubscriptionAuth({ forUser }, secrets, {
    start: () => errAsync({ code: "unavailable", message: "unexpected login" }),
  });
  const read = vi.spyOn(pointers, "readPointer");
  const check = createSpawnModelCheck(
    (owner) => ({
      pointers: forUser(owner),
      secrets,
      upstreams: {},
      constants: DEFAULT_BROKER_CONSTANTS,
    }),
    auth,
  );
  const result = await check(task, "owner", { provider, id });
  expect(result.isErr() ? result.error.reason : null).toBe(reason);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(forUser).toHaveBeenCalledWith("owner");
  expect(read.mock.calls.every(([, selected]) => selected === slot)).toBe(true);
  if (provider !== "claude" || mode === "disconnected") expect(sdk.query).not.toHaveBeenCalled();
  else if (mode !== "query") {
    const call = sdk.query.mock.calls[0]?.[0];
    expect(call.options).toMatchObject({
      persistSession: false,
      settingSources: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "owner-token" },
    });
    expect(await call.prompt.next()).toMatchObject({ done: true });
    expect(sdk.close).toHaveBeenCalledTimes(1);
  }
});

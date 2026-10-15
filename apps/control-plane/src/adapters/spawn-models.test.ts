import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { BrokerDeps, StoredSecret } from "../domain/ports.ts";
import { createSpawnModelCheck } from "./spawn-models.ts";

const task = new NoSimulationTask("spawn-model", false);
function fixture(
  secret: StoredSecret | null = {
    kind: "claude_subscription",
    token: "owner-token",
    createdAt: 0,
  },
) {
  const readPointer = vi.fn(() => okAsync(secret === null ? null : { secretVersion: "version" }));
  const readSecret = vi.fn(() => okAsync(secret));
  const broker = vi.fn(
    () => ({ pointers: { readPointer }, secrets: { readSecret } }) as unknown as BrokerDeps,
  );
  const checkClaude = vi.fn(() => okAsync<void>(undefined));
  return {
    broker,
    checkClaude,
    readPointer,
    readSecret,
    check: createSpawnModelCheck(broker, checkClaude),
  };
}

it("checks only the requested provider with owner credentials", async () => {
  const f = fixture();
  expect((await f.check(task, "owner", { provider: "claude", id: "opus" })).isOk()).toBe(true);
  expect(f.broker).toHaveBeenCalledWith("owner");
  expect(f.readPointer).toHaveBeenCalledExactlyOnceWith(task, "claude");
  expect(f.readSecret).toHaveBeenCalledExactlyOnceWith(task, "claude", "version");
  expect(f.checkClaude).toHaveBeenCalledExactlyOnceWith("owner-token", "opus");
});
it("rejects disconnected owners without starting SDK discovery", async () => {
  const f = fixture(null);
  expect(
    (await f.check(task, "owner", { provider: "claude", id: "opus" }))._unsafeUnwrapErr().reason,
  ).toBe("disconnected");
  expect(f.checkClaude).not.toHaveBeenCalled();
});
it.each([
  ["gpt-6.1-sol", true],
  ["unknown", false],
] as const)("checks exact Pi ID %s without Claude discovery", async (id, accepted) => {
  const f = fixture({ access: "a", refresh: "r", accountId: "owner", expiresAt: 100 });
  expect((await f.check(task, "owner", { provider: "openai-codex", id })).isOk()).toBe(accepted);
  expect(f.readPointer).toHaveBeenCalledExactlyOnceWith(task, "openai-codex");
  expect(f.checkClaude).not.toHaveBeenCalled();
});
it("preserves typed lookup failures", async () => {
  const f = fixture();
  const check = createSpawnModelCheck(f.broker, () =>
    errAsync({
      type: "spawn_model_error",
      reason: "unavailable",
      message: "Lookup unavailable.",
    }),
  );
  expect(
    (await check(task, "owner", { provider: "claude", id: "opus" }))._unsafeUnwrapErr().reason,
  ).toBe("unavailable");
});
it("rejects a non-Codex secret for Pi admission", async () => {
  const f = fixture();
  expect(
    (
      await f.check(task, "owner", { provider: "openai-codex", id: "gpt-6.1-sol" })
    )._unsafeUnwrapErr().reason,
  ).toBe("unavailable");
  expect(f.checkClaude).not.toHaveBeenCalled();
});

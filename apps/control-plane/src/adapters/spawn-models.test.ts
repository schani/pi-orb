import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { BrokerDeps, StoredSecret } from "../domain/ports.ts";
import { createSpawnModels } from "./spawn-models.ts";

const task = new NoSimulationTask("spawn-catalog", false);
const subscription = { kind: "claude_subscription", token: "owner-token", createdAt: 0 } as const;
function broker(secret: StoredSecret | null = subscription) {
  const readPointer = vi.fn(() => okAsync(secret === null ? null : { secretVersion: "version" }));
  const readSecret = vi.fn(() => okAsync(secret));
  const owner = vi.fn(
    () => ({ pointers: { readPointer }, secrets: { readSecret } }) as unknown as BrokerDeps,
  );
  return { owner, readPointer, readSecret };
}

describe("owner spawn catalog", () => {
  it("reads owner credentials without broker refresh or writes", async () => {
    const { owner, readSecret } = broker();
    const discover = vi.fn(() =>
      okAsync([{ provider: "claude", id: "opus", name: "Opus", thinkingLevels: [] }]),
    );
    const catalog = (
      await createSpawnModels(owner, discover).read(task, "owner", "Opus")
    )._unsafeUnwrap();
    expect(owner).toHaveBeenCalledWith("owner");
    expect(discover).toHaveBeenCalledWith("owner-token");
    expect(catalog.disconnected).toEqual([]);
    expect(catalog.models.find((m) => m.name === "Sol")?.id).toBe("gpt-6.1-sol");
    expect(catalog.models.find((m) => m.name === "Opus")?.id).toBe("opus");
    expect(readSecret).toHaveBeenCalledTimes(1);
  });
  it("does not launch discovery for a disconnected owner", async () => {
    const { owner } = broker(null);
    const discover = vi.fn();
    const result = await createSpawnModels(owner, discover).read(task, "owner", "Opus");
    expect(result._unsafeUnwrap().disconnected).toEqual(["claude"]);
    expect(discover).not.toHaveBeenCalled();
  });
  it("does not consult Claude credentials or SDK for Sol", async () => {
    const { owner, readPointer } = broker({
      access: "access",
      refresh: "refresh",
      accountId: "owner",
      expiresAt: 100,
    });
    const discover = vi.fn();
    const catalog = (
      await createSpawnModels(owner, discover).read(task, "owner", "Sol")
    )._unsafeUnwrap();
    expect(catalog.disconnected).toEqual([]);
    expect(readPointer).toHaveBeenCalledTimes(1);
    expect(readPointer).toHaveBeenCalledWith(task, "openai-codex");
    expect(discover).not.toHaveBeenCalled();
  });
  it("distinguishes a known family absent from SDK advertisement", async () => {
    const { owner } = broker();
    const result = await createSpawnModels(owner, () => okAsync([])).read(task, "owner", "Fable");
    expect(result.isErr() && result.error.reason).toBe("unadvertised");
  });
  it("propagates typed discovery failures", async () => {
    const { owner } = broker();
    const result = await createSpawnModels(owner, () =>
      errAsync({
        type: "spawn_model_error",
        reason: "unavailable",
        message: "Claude model catalog unavailable.",
      }),
    ).read(task, "owner", "Opus");
    expect(result.isErr() && result.error.reason).toBe("unavailable");
  });
});

import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import { PiActivityHeadlineGenerator } from "./pi-headline-generator.ts";

const mocks = vi.hoisted(() => ({ complete: vi.fn(() => okAsync("Never admitted")) }));
vi.mock("@pi-orb/luna", () => ({ completeLuna: mocks.complete }));
it.each(["cancel", "expiry"] as const)(
  "real headline broker blocks credential/provider IO after %s during pointer lookup",
  async (mode) => {
    mocks.complete.mockClear();
    const task = new NoSimulationTask("real headline broker admission", false);
    const clock = vi.spyOn(task, "monotonicNow").mockReturnValue(100);
    const controller = new AbortController();
    const pointers = new FakePointerStore();
    const secrets = new FakeSecretStore();
    const upstream = new FakeUpstream("unseeded");
    const credential = makeCredential(task, { expiresInMs: 3_600_000 });
    const provider = "openai-codex";
    const version = secrets.seedSecret(provider, credential);
    pointers.seedRow({
      provider,
      rowVersion: 1,
      generation: 1,
      secretVersion: version,
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = pointers.readPointer.bind(pointers);
    const pointer = vi
      .spyOn(pointers, "readPointer")
      .mockImplementationOnce((t, p) => new ResultAsync(held.then(async () => await read(t, p))));
    const secret = vi.spyOn(secrets, "readSecret");
    const refresh = vi.spyOn(upstream, "refresh");
    const generator = new PiActivityHeadlineGenerator(() => ({
      pointers,
      secrets,
      upstreams: { [provider]: upstream },
      constants: DEFAULT_BROKER_CONSTANTS,
    }));
    const result = generator.generate(
      task,
      {
        ownerUserId: "owner",
        source: { kind: "intent", tool: "codemode", text: "PRIVATE_SOURCE" },
      },
      { signal: controller.signal, deadlineAt: 30_100 },
    );
    expect(pointer).toHaveBeenCalledOnce();
    if (mode === "cancel") controller.abort();
    else clock.mockReturnValue(30_101);
    release();
    expect((await result)._unsafeUnwrapErr()).toEqual({
      type: "headline_generation_failed",
      stage: "cancelled",
    });
    expect(secret).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  },
);

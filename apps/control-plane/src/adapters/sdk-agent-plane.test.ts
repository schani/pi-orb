import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { OrbRow } from "../domain/orb.ts";
import type { OrbHostProvider, OrbRuntimeClient } from "../domain/ports.ts";
import { SdkAgentPlane } from "./sdk-agent-plane.ts";

describe("host SDK agent plane", () => {
  it("uses the matching observed incarnation, not an old delivery address", async () => {
    const health = vi.fn(() => okAsync({ status: "initializing", phase: "cloning" }));
    const observe = vi.fn(() =>
      okAsync({ incarnation: 7, state: "running", runtimeAddress: { baseUrl: "http://current" } }),
    );
    const plane = new SdkAgentPlane({
      control: { noteRuntimeRequestStarted: vi.fn() },
      hostProvider: { kind: "docker", observe } as unknown as OrbHostProvider,
      runtimeClient: { health } as unknown as OrbRuntimeClient,
    });
    const task = new NoSimulationTask("sdk", false);
    const orb = { id: "orb", hostRef: "host", hostIncarnation: 7 } as OrbRow;
    expect((await plane.health(task, orb, { signal: new AbortController().signal })).isOk()).toBe(
      true,
    );
    expect(health).toHaveBeenCalledWith(task, "http://current", expect.anything());
    observe.mockReturnValueOnce(
      okAsync({ incarnation: 6, state: "running", runtimeAddress: { baseUrl: "http://stale" } }),
    );
    expect((await plane.health(task, orb, { signal: new AbortController().signal })).isErr()).toBe(
      true,
    );
    expect(health).toHaveBeenCalledTimes(1);
  });
  it.each(["pullHistory", "deliverMessage"] as const)(
    "does not start guest silence or dispatch %s when held observation is cancelled",
    async (method) => {
      const controller = new AbortController();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = vi.fn();
      const transport = vi.fn(() => okAsync({}));
      const plane = new SdkAgentPlane({
        control: { noteRuntimeRequestStarted: started },
        hostProvider: {
          kind: "process",
          observe: () =>
            ResultAsync.fromSafePromise(held).map(() => ({
              incarnation: 7,
              state: "running",
              runtimeAddress: { baseUrl: "http://current" },
            })),
        } as unknown as OrbHostProvider,
        runtimeClient: { [method]: transport } as unknown as OrbRuntimeClient,
      });
      const task = new NoSimulationTask("sdk cancelled transport", false);
      const orb = { id: "orb", hostRef: "host", hostIncarnation: 7 } as OrbRow;
      const context = { signal: controller.signal };
      const pending =
        method === "pullHistory"
          ? plane.pullHistory(task, orb, { baseUrl: "http://old", after: null, limit: 1 }, context)
          : plane.deliverMessage(
              task,
              orb,
              {
                baseUrl: "http://old",
                messageId: "message",
                messageIds: ["message"],
                content: [{ type: "text", text: "hello" }],
              },
              context,
            );
      expect(started).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      controller.abort();
      release();
      expect((await pending).isErr()).toBe(true);
      expect(started).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch after cancellation during observation", async () => {
    const controller = new AbortController();
    const health = vi.fn();
    const observe = vi.fn(() => {
      controller.abort();
      return okAsync({
        incarnation: 7,
        state: "running",
        runtimeAddress: { baseUrl: "http://current" },
      });
    });
    const plane = new SdkAgentPlane({
      control: { noteRuntimeRequestStarted: vi.fn() },
      hostProvider: { kind: "gce", observe } as unknown as OrbHostProvider,
      runtimeClient: { health } as unknown as OrbRuntimeClient,
    });
    expect(
      (
        await plane.health(
          new NoSimulationTask("sdk", false),
          { id: "orb", hostRef: "host", hostIncarnation: 7 } as OrbRow,
          { signal: controller.signal },
        )
      ).isErr(),
    ).toBe(true);
    expect(health).not.toHaveBeenCalled();
  });
});

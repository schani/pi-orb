import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { runDst, waitUntil } from "../../../testkit/sim.ts";
import { CallableCatalog } from "./catalog.ts";

it("never dispatches after cancellation during asynchronous authorization", async () => {
  await runDst({ name: "codemode-authorization-cancellation", iterations: 25 }, async (sim) => {
    let entered = false,
      released = false,
      effects = 0;
    const abort = new AbortController();
    const result = await sim.runTasks([
      {
        name: "invoke",
        f: async (task) => {
          const catalog = new CallableCatalog(
            [
              defineTool({
                name: "effect",
                description: "effect",
                parameters: Type.Object({}),
                execute: async () => {
                  effects++;
                  return {};
                },
              }),
            ],
            () =>
              ResultAsync.fromSafePromise(
                (async () => {
                  entered = true;
                  await waitUntil(task, "authorization revoked", () => released);
                  return undefined;
                })(),
              ),
          );
          const called = await catalog.invoke(
            "effect",
            {},
            {} as ToolExecutionApi,
            withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
          );
          expect(called.isErr()).toBe(true);
        },
      },
      {
        name: "cancel",
        f: async (task) => {
          await waitUntil(task, "authorization entered", () => entered);
          abort.abort();
          await task.checkpoint("revoked-before-authorized");
          released = true;
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
    expect(effects).toBe(0);
  });
});

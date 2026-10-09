import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { buildExecutionServer } from "../../../../../orb-runtime/src/execution/server.ts";
import { RemoteExecutionEnv } from "../../execution-client/env.ts";
import { createDurableTools } from "./index.ts";

it("returns script-visible remote bash data including nonzero exit without leaking stdout", async () => {
  const app = buildExecutionServer({ token: "token", incarnation: "1", cwd: tmpdir() });
  const bundle = createDurableTools();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const env = new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "1",
      cwd: tmpdir(),
    });
    const root = await harness.root(BACKGROUND_CONTEXT);
    const emitted: string[] = [];
    const api = {
      env,
      conversationId: root.id,
      commit: root.commit.bind(root),
      callId: "outer",
      taskId: 1,
      output: (s: string) => emitted.push(s),
      details: async () => {},
      diagnostic: () => {},
    } as unknown as ToolExecutionApi;
    const code = bundle.modelTools[0];
    for (const exit of [0, 23]) {
      const result = await code.execute(
        {
          code: `const r=await tools.bash({command:"echo secret-output; exit ${exit}"}); text({exit:r.exit_code,hasOutput:r.output.includes("secret-output"),time:r.wall_time_seconds>=0});`,
        },
        api,
        BACKGROUND_CONTEXT,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify({ exit, hasOutput: true, time: true }),
      });
      expect(emitted).toEqual([]);
      expect(JSON.stringify(result.content)).not.toContain("secret-output");
    }
    const unicode = await code.execute(
      {
        code: `const r=await tools.bash({command:${JSON.stringify("node -e 'process.stdout.write(\"😀\".repeat(350000))'")}}); text({truncated:r.truncated,clipped:r.output.length<700000});`,
      },
      api,
      BACKGROUND_CONTEXT,
    );
    expect(unicode.isError).toBe(false);
    expect(unicode.content).toContainEqual({
      type: "text",
      text: JSON.stringify({ truncated: true, clipped: true }),
    });
    expect(emitted).toEqual([]);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await bundle.close();
    await app.close();
  }
});

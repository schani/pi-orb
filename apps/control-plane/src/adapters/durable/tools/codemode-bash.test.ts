import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { buildExecutionServer } from "../../../../../orb-runtime/src/execution/server.ts";
import { RemoteExecutionEnv } from "../../execution-client/env.ts";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("returns script-visible remote bash data including nonzero exit without leaking stdout", async () => {
  const app = buildExecutionServer({ token: "token", incarnation: "1", cwd: tmpdir() });
  const bundle = createDurableTools();
  let fixture: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const env = new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "1",
      cwd: tmpdir(),
    });
    fixture = await openCodemodeHarness(bundle.catalog, { env });
    for (const exit of [0, 23]) {
      const result = await fixture.run(
        `const r=await tools.bash({command:"echo secret-output; exit ${exit}"}); text({exit:r.exit_code,hasOutput:r.output.includes("secret-output"),time:r.wall_time_seconds>=0});`,
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContainEqual({
        type: "text",
        text: JSON.stringify({ exit, hasOutput: true, time: true }),
      });
      expect(JSON.stringify(result.output)).not.toContain("secret-output");
    }
    const unicode = await fixture.run(
      `const r=await tools.bash({command:${JSON.stringify("node -e 'process.stdout.write(\"😀\".repeat(350000))'")}}); text({truncated:r.truncated,clipped:r.output.length<700000});`,
    );
    expect(unicode.isError).toBe(false);
    expect(unicode.output).toContainEqual({
      type: "text",
      text: JSON.stringify({ truncated: true, clipped: true }),
    });
  } finally {
    await fixture?.close();
    await bundle.close();
    await app.close();
  }
});

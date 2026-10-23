import { tmpdir } from "node:os";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { expect, test } from "vitest";
import {
  buildExecutionServer,
  executionContext,
} from "../../../../../orb-runtime/src/execution/server.ts";
import { RemoteExecutionEnv } from "../../execution-client/env.ts";
import { CallableCatalog } from "./catalog.ts";

test("actual remote built-in bash failure retains stdout, stderr and safe exit diagnostic", async () => {
  const app = buildExecutionServer({ token: "token", incarnation: "3", cwd: tmpdir() });
  try {
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const env = new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "3",
      cwd: tmpdir(),
    });
    const streamed: string[] = [];
    const api = {
      now: () => 0,
      env,
      output: (text: string) => streamed.push(text),
      diagnostic: () => {},
    } as unknown as ToolExecutionApi;
    const catalog = new CallableCatalog([createBashTool()]);
    const result = await catalog
      .registrations()[0]!
      .execute(
        { command: "echo stdout-detail; echo stderr-detail >&2; exit 23" },
        api,
        executionContext(),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredOutput).toMatchObject({ exitCode: 23 });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "exit_code", message: "Command exited with code 23" }),
    );
    expect(JSON.stringify(result.output)).toContain("stdout-detail");
    expect(JSON.stringify(result.output)).toContain("stderr-detail");
    expect(streamed.join("")).toContain("stderr-detail");
    await app.close();
    const failed = await catalog
      .registrations()[0]!
      .execute({ command: "echo INPUT_SECRET" }, api, executionContext());
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.output)).toContain(
      "execution transport failed; effects may have occurred",
    );
    expect(JSON.stringify(failed.output)).not.toContain("INPUT_SECRET");
  } finally {
    await app.close();
  }
});

test("exposes only the bounded pre-execution admission reason", async () => {
  for (const [name, ErrorType] of [
    ["bash", ExecutionError],
    ["read", FileError],
  ] as const) {
    for (const message of ["execution admission revoked", "PRIVATE AGENTS CONTENT"]) {
      const catalog = new CallableCatalog([
        defineTool({
          name,
          description: "test",
          parameters: Type.Object({}),
          execute: async () => {
            throw new ErrorType("unknown", message);
          },
        }),
      ]);
      const result = await catalog
        .registrations()[0]!
        .execute({}, {} as ToolExecutionApi, executionContext());
      const output = JSON.stringify(result);
      expect(output).not.toContain("PRIVATE AGENTS CONTENT");
      if (message === "execution admission revoked") expect(output).toContain(message);
    }
  }
});

test("untrusted tool exceptions remain sanitized, including unexpected bash failures", async () => {
  for (const name of ["mcp_external", "bash"]) {
    const tool = defineTool({
      name,
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("TOKEN_SECRET arbitrary provider error");
      },
    });
    const catalog = new CallableCatalog([tool]);
    const result = await catalog
      .registrations()[0]!
      .execute({}, {} as ToolExecutionApi, executionContext());
    expect(result.output).toEqual([{ type: "text", text: `${name} failed` }]);
  }
});

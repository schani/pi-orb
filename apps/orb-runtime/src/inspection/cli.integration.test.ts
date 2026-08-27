import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const cli = join(repositoryRoot, "apps/orb-runtime/docker/pi-orb");
const TOKEN = "inspection-cli-token";

const orb = {
  id: "orb-sibling",
  name: "Parser work",
  state: "stopped",
  updatedAt: "2026-08-27T00:00:00.000Z",
  project: {
    id: "project-a",
    name: "Client App",
    repositoryUrl: "https://github.com/example/client",
  },
} as const;

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(baseUrl: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PI_ORB_CONTROL_PLANE_URL: baseUrl,
        PI_ORB_RUNTIME_TOKEN: TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("pi-orb inspection CLI entry point", () => {
  let server: Server;
  let baseUrl: string;
  let mode: "ok" | "unauthorized" | "missing";

  beforeEach(async () => {
    mode = "ok";
    server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      response.setHeader("content-type", "application/json");
      if (mode === "unauthorized") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (mode === "missing") {
        response.statusCode = 404;
        response.end(
          JSON.stringify({
            v: 1,
            error: { code: "not_found", message: "orb not found", retryable: false },
          }),
        );
        return;
      }
      if (request.url === "/runtime/v1/orbs") {
        response.end(JSON.stringify({ v: 1, currentOrbId: "orb-current", items: [orb] }));
        return;
      }
      if (request.url === "/runtime/v1/orbs/orb-sibling/transcript") {
        response.end(
          JSON.stringify({
            v: 1,
            orb,
            session: { id: "session-a", overflow: { native: { privateDuplicate: true } } },
            cursor: "record-1",
            headId: "record-1",
            records: [
              {
                id: "record-1",
                parentId: null,
                timestamp: "2026-08-27T00:00:01.000Z",
                type: "message",
                role: "user",
                content: [{ type: "text", text: "Fix parsing" }],
                overflow: { native: { privateDuplicate: true } },
              },
            ],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("prints a successful no-match search as an empty table", async () => {
    const result = await runCli(baseUrl, ["orbs", "does-not-match"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("CURRENT\tORB ID\tNAME\tSTATE\tPROJECT\tREPOSITORY\n");
  });

  it("prints the exact lossless transcript response in JSON mode", async () => {
    const result = await runCli(baseUrl, ["transcript", "orb-sibling", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as { records?: unknown[] };
    expect(body.records).toHaveLength(1);
    expect(result.stdout).toContain('"privateDuplicate": true');
  });

  it("uses the unauthorized exit class without writing stdout", async () => {
    mode = "unauthorized";
    const result = await runCli(baseUrl, ["orbs"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("control plane rejected this orb's identity");
  });

  it("uses the missing-resource exit class and preserves the server message", async () => {
    mode = "missing";
    const result = await runCli(baseUrl, ["transcript", "missing-orb"]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("pi-orb: orb not found\n");
  });
});

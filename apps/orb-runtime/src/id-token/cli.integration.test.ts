import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

describe("identity CLI diagnostic stream", () => {
  it("validates invalid arguments before contacting the endpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "invalid-id-token-cli-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ token: "unexpected" }));
    });
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [
            fileURLToPath(new URL("./cli.ts", import.meta.url)),
            "--audience",
            "a",
            "--ttl-seconds",
            "10",
          ],
          {
            cwd,
            env: {
              ...process.env,
              PI_ORB_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
              PI_ORB_RUNTIME_TOKEN: "test",
            },
            timeout: 15_000,
          },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--ttl-seconds must be 60..3600");
    expect(requests).toBe(0);
  });

  it.each(["0", "1"])("keeps token-only stdout with diagnostics=%s", async (diagnostics) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ token: "TEST_ONLY_TOKEN" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("./cli.ts", import.meta.url)), "--audience", "TEST_ONLY_AUDIENCE"],
        {
          env: {
            ...process.env,
            PI_ORB_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
            PI_ORB_RUNTIME_TOKEN: "TEST_ONLY_BEARER",
            PI_ORB_ID_TOKEN_DIAGNOSTICS: diagnostics,
          },
          timeout: 15_000,
        },
      );
      expect(stdout).toBe("TEST_ONLY_TOKEN\n");
      expect(stderr).not.toContain("TEST_ONLY");
      if (diagnostics === "0") expect(stderr).toBe("");
      else {
        const events = stderr
          .trim()
          .split("\n")
          .map((line) => {
            expect(line.startsWith("identity-mint: ")).toBe(true);
            return JSON.parse(line.slice("identity-mint: ".length));
          });
        expect(events.map((event) => event.event)).toEqual(["attempt", "result"]);
        expect(events[0].timeoutMs).toBeGreaterThan(0);
        expect(events[0].timeoutMs).toBeLessThanOrEqual(10_000);
        expect(events[1].outcome).toBe("token");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

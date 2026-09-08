import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../..");
const id = "00000000-0000-4000-8000-000000000003";
const url = `https://browser.test/#/orbs/${id}`;
function run(base: string, args: string[], input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(join(root, "apps/orb-runtime/docker/pi-orb"), ["spawn", ...args], {
      env: { ...process.env, PI_ORB_CONTROL_PLANE_URL: base, PI_ORB_RUNTIME_TOKEN: "token" },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("spawn CLI entry point", () => {
  let server: Server;
  let base: string;
  let directory: string;
  let received: unknown[];
  beforeEach(async () => {
    received = [];
    directory = await mkdtemp(join(tmpdir(), "pi-orb-spawn-"));
    server = createServer((request, response) => {
      expect(request.method).toBe("PUT");
      expect(request.headers.authorization).toBe("Bearer token");
      expect(request.url).toBe(`/runtime/v1/orbs/${id}/spawn`);
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        received.push(JSON.parse(body));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ orbId: id, projectId: "project", messageId: id, url }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  it("prints only the URL and accepts stdin without changing its text", async () => {
    const result = await run(base, ["--id", id, "--prompt-file", "-"], "multi\nline π\n");
    expect(result).toEqual({ code: 0, stdout: `${url}\n`, stderr: "" });
    expect(received).toEqual([{ prompt: "multi\nline π\n" }]);
  });
  it("reads a file and renders JSON", async () => {
    const file = join(directory, "task.md");
    await writeFile(file, "work");
    const result = await run(base, ["--id", id, "--prompt-file", file, "--name", "Task", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      orbId: id,
      projectId: "project",
      messageId: id,
      url,
    });
    expect(received).toEqual([{ prompt: "work", name: "Task" }]);
  });
  it("rejects missing and oversized files without a network mutation", async () => {
    expect((await run(base, ["--prompt-file", join(directory, "absent")])).code).toBe(2);
    const file = join(directory, "big");
    await writeFile(file, "x".repeat(1024 * 1024 + 1));
    const result = await run(base, ["--prompt-file", file]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(received).toEqual([]);
  });
});

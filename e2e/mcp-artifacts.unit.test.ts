import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { finishMcpFixture } from "./mcp-artifacts.ts";

it.each([false, true])(
  "cleans up after %s failure while retaining only safe evidence on failure",
  async (failed) => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-artifacts-test-"));
    const root = join(directory, "runtime");
    const artifactDirectory = join(directory, "artifacts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(root);
    writeFileSync(join(root, "private"), "secret-runtime");
    const close = vi.fn(async () => {});
    const removeProjects = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const deleteSession = vi.fn(async (_id: string) => {});
    const capture = vi.fn(async () => ({ requests: [{ status: 200 }], history: { orb: [] } }));
    try {
      await finishMcpFixture({
        failed,
        root,
        artifactDirectory,
        sessions: ["sess_test", "sess_names"],
        mockOrigin: "http://127.0.0.1:4321",
        capture,
        close,
        removeProjects,
        stop,
        deleteSession,
      });
      expect(close).toHaveBeenCalledOnce();
      expect(removeProjects).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(existsSync(root)).toBe(false);
      expect(capture).toHaveBeenCalledTimes(failed ? 1 : 0);
      expect(deleteSession).toHaveBeenCalledTimes(failed ? 0 : 2);
      if (failed) {
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(artifactDirectory);
        expect(files).toHaveLength(1);
        const evidence = readFileSync(join(artifactDirectory, files[0] ?? "missing"), "utf8");
        expect(JSON.parse(evidence)).toEqual({ requests: [{ status: 200 }], history: { orb: [] } });
        expect(evidence).not.toContain("secret-runtime");
      } else expect(existsSync(artifactDirectory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("diagnostic and teardown errors cannot replace the test failure or prevent stopping", async () => {
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), "mcp-artifacts-test-"));
  const stop = vi.fn(async () => {});
  const deleteSession = vi.fn(async (_id: string) => {});
  try {
    await expect(
      finishMcpFixture({
        failed: true,
        root: directory,
        artifactDirectory: join(directory, "artifacts"),
        sessions: ["sess_test"],
        mockOrigin: "http://127.0.0.1:4321",
        capture: async () => {
          throw new Error("secret failure");
        },
        close: async () => {
          throw new Error("secret close");
        },
        removeProjects: async () => {},
        stop,
        deleteSession,
      }),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(logs.mock.calls.flat().join(" ")).toContain("http://127.0.0.1:4321/ sess_test");
    expect(logs.mock.calls.flat().join(" ")).not.toContain("secret");
  } finally {
    logs.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fails successful tests on cleanup errors after attempting all resources, without leaking error details", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-artifacts-test-"));
  const close = vi.fn(async () => {
    throw new Error("secret browser credential");
  });
  const removeProjects = vi.fn(async () => {
    throw new Error("secret project prompt");
  });
  const stop = vi.fn(async () => {});
  const shutdownRemote = vi.fn(async () => {});
  const deleteSession = vi.fn(async (id: string) => {
    if (id === "sess_first") throw new Error("secret session token");
  });
  const capture = vi.fn(async () => ({}));
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let thrown: unknown;
    try {
      await finishMcpFixture({
        failed: false,
        root: directory,
        artifactDirectory: join(directory, "artifacts"),
        sessions: ["sess_first", "sess_second"],
        mockOrigin: "http://127.0.0.1:4321",
        capture,
        close,
        removeProjects,
        stop,
        shutdownRemote,
        deleteSession,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "MCP fixture browser close failed",
      "MCP fixture project cleanup failed",
      "MCP fixture session deletion failed",
    ]);
    expect(String(thrown)).not.toContain("secret");
    expect(
      (thrown as AggregateError).errors.every((error: Error) => error.cause === undefined),
    ).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(removeProjects).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(shutdownRemote).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
    expect(logs.mock.calls.flat().join(" ")).not.toContain("secret");
  } finally {
    logs.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

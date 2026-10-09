import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionReadySchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { ExecutionBoot } from "./boot.ts";

test("execution boot preserves incarnation-scoped launch failure injection and its durable receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-launch-failure-"));
  try {
    await writeFile(join(root, "armed.json"), JSON.stringify({ orbId: "test", incarnation: 3 }));
    const boot = new ExecutionBoot({
      orbId: "test",
      workDir: root,
      repositoryUrl: "invalid-test-repository",
      incarnation: "3",
      skillsDir: "",
      broker: null,
      environment: {
        PI_ORB_ID: "test",
        PI_ORB_HOST_INCARNATION: "3",
        PI_ORB_E2E_LAUNCH_FAILURE_MARKER: "armed.json",
      },
    });
    const result = await boot.boot();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("e2e_launch_failure");
    expect(boot.health()).toMatchObject({
      status: "failed",
      error: { code: "e2e_launch_failure", retryable: true },
    });
    expect(boot.snapshot).toBeNull();
    expect(await readFile(join(root, ".pi-orb-e2e-launch-failure-events.jsonl"), "utf8")).toContain(
      '"orbId":"test","incarnation":3,"injected":true',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh boot stays initializing before pin and surfaces terminal Git failure without cloning", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-pending-pin-"));
  let requested!: () => void;
  const seen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let release!: () => void;
  const server = createServer((request, response) => {
    expect(request.url).toBe("/api/runtime/initial-checkout");
    expect(request.headers["x-orb-incarnation"]).toBe("3");
    release = () => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "resource_acquisition_failed" }));
    };
    requested();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") return;
  const boot = new ExecutionBoot({
    orbId: "test",
    workDir: root,
    repositoryUrl: "https://github.com/test/test",
    incarnation: "3",
    skillsDir: "",
    environment: { PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT: "1" },
    broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
  });
  try {
    const result = boot.boot();
    await seen;
    expect(boot.health()).toMatchObject({ status: "initializing", phase: "cloning" });
    expect(boot.snapshot).toBeNull();
    release();
    expect((await result).isErr()).toBe(true);
    expect(boot.health()).toMatchObject({
      status: "failed",
      error: { code: "resource_acquisition_failed" },
    });
  } finally {
    boot.shutdown();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test.each([0, 3])(
  "checkout and hooks preserve readiness with hook exit %i without loading repository JavaScript",
  async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "execution-boot-"));
    try {
      const repo = join(root, "repo");
      await mkdir(join(repo, ".agents"), { recursive: true });
      execFileSync("git", ["init", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      await writeFile(join(repo, "AGENTS.md"), "root instructions");
      await mkdir(join(repo, ".pi"), { recursive: true });
      await writeFile(join(repo, "CLAUDE.md"), "repository instructions");
      await symlink("../CLAUDE.md", join(repo, ".pi", "AGENTS.md"));
      await mkdir(join(repo, "skill-assets", "review"), { recursive: true });
      await writeFile(join(repo, "skill-assets", "review", "SKILL.md"), "review skill");
      await mkdir(join(repo, ".agents", "skills"), { recursive: true });
      await symlink("../../skill-assets/review", join(repo, ".agents", "skills", "review"));
      await writeFile(
        join(repo, ".agents", "setup"),
        `#!/bin/sh\necho setup >> runs\nexit ${exitCode}\n`,
      );
      await writeFile(
        join(repo, ".agents", "resume"),
        `#!/bin/sh\necho resume >> runs\nexit ${exitCode}\n`,
      );
      await chmod(join(repo, ".agents", "setup"), 0o755);
      await chmod(join(repo, ".agents", "resume"), 0o755);
      await mkdir(join(repo, ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(repo, ".pi", "extensions", "bad.js"),
        "throw new Error('must not load')",
      );
      const boot = new ExecutionBoot({
        orbId: "test",
        workDir: root,
        repositoryUrl: "https://github.com/test/test",
        incarnation: "3",
        skillsDir: join(root, "skills"),
        environment: {
          ...process.env,
          PI_ORB_INITIAL_CHECKOUT_COMMIT: exitCode === 0 ? "a".repeat(40) : "",
          PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT: "1",
        },
        broker: null,
      });
      expect((await boot.boot()).isOk()).toBe(true);
      expect(boot.snapshot?.checkoutCommit).toMatch(/^[a-f0-9]{40}$/);
      const hooks = boot.health();
      expect(hooks.status).toBe("ready");
      if (hooks.status !== "ready") return;
      expect(boot.snapshot).toMatchObject({
        hooks: {
          setup: { outcome: exitCode === 0 ? "ok" : "failed", exitCode, incarnation: "3" },
          resume: { outcome: exitCode === 0 ? "ok" : "failed", exitCode, incarnation: "3" },
        },
      });
      expect(boot.snapshot).toHaveProperty("hooks", hooks.hooks);
      expect(Check(ExecutionReadySchema, boot.snapshot)).toBe(true);
      expect(
        Check(ExecutionReadySchema, { ...boot.snapshot, hooks: { setup: { outcome: "failed" } } }),
      ).toBe(false);
      expect(boot.snapshot?.instructions).toEqual([
        {
          path: join(repo, ".pi", "AGENTS.md"),
          content: "repository instructions",
        },
      ]);
      expect(boot.snapshot?.skills).toEqual([
        { path: join(repo, ".agents", "skills", "review", "SKILL.md"), content: "review skill" },
      ]);
      expect(await readFile(join(repo, "runs"), "utf8")).toBe("setup\nresume\n");
      boot.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

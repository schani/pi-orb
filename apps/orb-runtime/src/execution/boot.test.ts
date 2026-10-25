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
      await symlink("missing-instructions", join(repo, "AGENTS.md"));
      await mkdir(join(repo, ".agents", "skills"), { recursive: true });
      await symlink("missing-skill", join(repo, ".agents", "skills", "broken"));
      await writeFile(
        join(repo, ".agents", "setup"),
        `#!/bin/sh\nmkdir -p .pi\nln -s missing-instructions .pi/AGENTS.md\necho setup >> runs\nexit ${exitCode}\n`,
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
      expect(Object.keys(boot.snapshot ?? {}).sort()).toEqual([
        "checkoutCommit",
        "cwd",
        "hooks",
        "incarnation",
        "pid",
      ]);
      expect(await readFile(join(repo, "runs"), "utf8")).toBe("setup\nresume\n");
      boot.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function gitIdentityBoot(
  serve: (url: string | undefined) => { status: number; body: unknown },
  run: (
    boot: (environment?: NodeJS.ProcessEnv) => Promise<ExecutionBoot>,
    root: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "execution-git-identity-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    expect(request.headers.authorization).toBe("Bearer private");
    const reply =
      request.url === "/runtime/v1/project-secrets"
        ? { status: 200, body: { revision: 0, values: {} } }
        : serve(request.url);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  try {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const { XDG_CONFIG_HOME: _xdg, ...inherited } = process.env;
    await run(async (environment = { ...inherited, GIT_CONFIG_NOSYSTEM: "1" }) => {
      const boot = new ExecutionBoot({
        orbId: "test",
        workDir: root,
        repositoryUrl: "https://github.com/test/test",
        incarnation: "3",
        environment,
        broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      });
      const fetches = () => requests.filter((url) => url === "/runtime/v1/git-identity").length;
      const before = fetches();
      await boot.boot();
      boot.shutdown();
      expect(fetches() - before).toBe(1);
      return boot;
    }, root);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}

test("boot applies the owner's git identity to the XDG file and leaves ~/.gitconfig to the orb", async () => {
  let identity = { name: "Ada Lovelace", email: "ada@example.com" };
  await gitIdentityBoot(
    () => ({ status: 200, body: identity }),
    async (boot, root) => {
      const home = join(root, "home");
      const xdg = join(home, ".config", "git", "config");
      const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
      const config = (...args: string[]) =>
        execFileSync("git", ["config", ...args], { cwd: home, env, encoding: "utf8" }).trim();
      await mkdir(join(home, ".config", "git"), { recursive: true });
      await writeFile(xdg, "[core]\n\teditor = vi\n[user]\n\tname = Old\n");
      expect((await boot()).health().status).toBe("ready");
      expect(config("--file", xdg, "user.name")).toBe("Ada Lovelace");
      expect(config("--file", xdg, "user.email")).toBe("ada@example.com");
      expect(config("--file", xdg, "core.editor")).toBe("vi");
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe("");
      expect(config("--get", "user.name")).toBe("Ada Lovelace");

      config("--global", "user.name", "Orb Override");
      identity = { name: "Grace Hopper", email: "grace@example.com" };
      expect((await boot()).health().status).toBe("ready");
      expect(config("--file", xdg, "user.name")).toBe("Grace Hopper");
      expect(config("--get", "user.name")).toBe("Orb Override");
      expect(config("--get", "user.email")).toBe("grace@example.com");
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toContain("Orb Override");

      identity = { name: "", email: "" };
      expect((await boot()).health().status).toBe("ready");
      expect(await readFile(xdg, "utf8")).not.toContain("Grace");
      expect(config("--file", xdg, "core.editor")).toBe("vi");
      expect((await boot()).health().status).toBe("ready");

      const custom = join(root, "xdg");
      identity = { name: "Custom", email: "custom@example.com" };
      expect(
        (await boot({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: custom })).health()
          .status,
      ).toBe("ready");
      expect(config("--file", join(custom, "git", "config"), "user.name")).toBe("Custom");
    },
  );
});

test("boot fails with git_identity_unavailable when the identity cannot be read", async () => {
  await gitIdentityBoot(
    () => ({ status: 503, body: { error: { code: "unavailable" } } }),
    async (boot, root) => {
      const booted = await boot();
      expect(booted.health()).toMatchObject({
        status: "failed",
        error: { code: "git_identity_unavailable" },
      });
      expect(booted.snapshot).toBeNull();
      await expect(readFile(join(root, "home", ".gitconfig"), "utf8")).rejects.toThrow();
    },
  );
});

test("repository-free execution readies without fetching or validating a Git pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-no-repo-"));
  const boot = new ExecutionBoot({
    orbId: "test",
    workDir: root,
    repositoryUrl: null,
    incarnation: "3",
    broker: null,
    environment: {
      ...process.env,
      PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT: "1",
      PI_ORB_INITIAL_CHECKOUT_COMMIT: "not-a-sha",
    },
  });
  try {
    expect((await boot.boot()).isOk()).toBe(true);
    expect(boot.snapshot).toMatchObject({ cwd: join(root, "repo"), checkoutCommit: null });
    expect(Check(ExecutionReadySchema, boot.snapshot)).toBe(true);
    expect(boot.health()).toMatchObject({ status: "ready", checkoutCommit: null });
  } finally {
    boot.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

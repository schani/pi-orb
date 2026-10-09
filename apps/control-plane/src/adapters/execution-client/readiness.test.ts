import { expect, test, vi } from "vitest";
import {
  buildExecutionServer,
  executionContext,
} from "../../../../orb-runtime/src/execution/server.ts";
import { RemoteExecutionEnv } from "./env.ts";

test.each([true, false])(
  "readiness preserves terminal initialization failure with retryable=%s",
  async (retryable) => {
    const app = buildExecutionServer({
      token: "token",
      incarnation: "3",
      cwd: "/missing",
      ready: () => null,
      health: () => ({
        v: 1,
        orbId: "orb",
        runtimeInstanceId: "runtime",
        status: "failed",
        error: { code: "clone_failed", message: "git checkout failed", retryable },
      }),
    });
    try {
      const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
      const env = new RemoteExecutionEnv({
        baseUrl,
        token: "token",
        incarnation: "3",
        cwd: "/missing",
      });
      const result = await env.ready(executionContext());
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error).toMatchObject({
          code: "initialization_failed",
          initializationError: {
            code: "clone_failed",
            message: "git checkout failed",
            retryable,
          },
        });
    } finally {
      await app.close();
    }
  },
);

test("execution readiness transports setup and resume failures without rejecting availability", async () => {
  const hooks = {
    setup: {
      hook: "setup" as const,
      outcome: "failed" as const,
      exitCode: 3,
      incarnation: "3",
      startedAt: "2026-08-06T00:00:00Z",
      endedAt: "2026-08-06T00:00:01Z",
      logPath: "/home/.cache/pi-orb/logs/setup.log",
    },
    resume: {
      hook: "resume" as const,
      outcome: "failed" as const,
      exitCode: 3,
      incarnation: "3",
      startedAt: "2026-08-06T00:00:01Z",
      endedAt: "2026-08-06T00:00:02Z",
      logPath: "/home/.cache/pi-orb/logs/resume.log",
    },
  };
  const snapshot = {
    cwd: "/repo",
    incarnation: "3",
    pid: 1,
    checkoutCommit: "commit",
    instructions: [],
    skills: [],
    resources: [],
    hooks,
  };
  const app = buildExecutionServer({
    token: "token",
    incarnation: "3",
    cwd: "/repo",
    ready: () => snapshot,
  });
  try {
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const result = await new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "3",
      cwd: "/repo",
    }).ready(executionContext());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(snapshot);
  } finally {
    await app.close();
  }
});

test("readiness preserves validated initializing health and hook reports", async () => {
  const initializationHealth = {
    v: 1 as const,
    orbId: "orb",
    runtimeInstanceId: "execution",
    status: "initializing" as const,
    phase: "setup_running" as const,
    hooks: {
      setup: {
        hook: "setup" as const,
        outcome: "failed" as const,
        exitCode: 3,
        incarnation: "3",
        startedAt: "2026-08-06T00:00:00Z",
        endedAt: "2026-08-06T00:00:01Z",
        logPath: "/home/.cache/pi-orb/logs/setup.log",
      },
    },
  };
  const app = buildExecutionServer({
    token: "token",
    incarnation: "3",
    cwd: "/repo",
    ready: () => null,
    health: () => initializationHealth,
  });
  try {
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const result = await new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "3",
      cwd: "/repo",
    }).ready(executionContext());
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toHaveProperty("initializationHealth", initializationHealth);
  } finally {
    await app.close();
  }
});

test("readiness without an HTTP answer remains an unproven transport error", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  try {
    const result = await new RemoteExecutionEnv({
      baseUrl: "http://executor",
      token: "token",
      incarnation: "3",
      cwd: "/repo",
    }).ready(executionContext());
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("unavailable");
      expect(result.error.initializationHealth).toBeUndefined();
      expect(result.error.initializationError).toBeUndefined();
    }
  } finally {
    request.mockRestore();
  }
});

test("unfinished initialization remains transient", async () => {
  const app = buildExecutionServer({
    token: "token",
    incarnation: "3",
    cwd: "/missing",
    ready: () => null,
  });
  try {
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const result = await new RemoteExecutionEnv({
      baseUrl,
      token: "token",
      incarnation: "3",
      cwd: "/missing",
    }).ready(executionContext());
    expect(result.isErr() && result.error.code).toBe("unavailable");
  } finally {
    await app.close();
  }
});

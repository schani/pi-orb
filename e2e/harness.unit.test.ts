import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachControlledClock,
  controlledClockSpawn,
  effectiveOpenAIResponseInstructions,
  FAKE_ORIGIN,
  fakeRequest,
  newModelRequestsById,
  requestIds,
} from "./harness.ts";

const connectionReset = (): TypeError =>
  new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });

const ok = (): Response => new Response("{}", { status: 200 });

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause as Error,
  );
  if (error === null) throw new Error("expected a rejection");
  return error;
};

describe("controlled control-plane clock", () => {
  const probe = resolve(import.meta.dirname, "testkit/control-plane-clock-probe.ts");

  it("advances monotonically with acknowledgements and does not leak into runtime children", async () => {
    const epoch = Date.parse("2040-01-01T00:00:00.000Z");
    const spec = controlledClockSpawn(probe, epoch);
    const child = spawn("node", spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const clock = attachControlledClock(child);
    try {
      const ready = await clock.ready;
      expect(ready.isOk()).toBe(true);
      if (ready.isErr()) return;
      expect(ready.value.now).toBeGreaterThan(epoch);

      const target = epoch + 86_400_000;
      const advanced = await clock.advanceTo(target);
      expect(advanced.isOk()).toBe(true);
      if (advanced.isErr()) return;
      expect(advanced.value.now).toBeGreaterThan(target);
      expect(advanced.value.now).toBeLessThan(target + 1_000);

      const nextTarget = target + 60_000;
      const next = await clock.advanceTo(nextTarget);
      expect(next.isOk()).toBe(true);
      if (next.isErr()) return;
      expect(next.value.now).toBeGreaterThan(nextTarget);
      expect(next.value.now).toBeGreaterThan(advanced.value.now);

      const rollback = await clock.advanceTo(target - 1);
      expect(rollback.isErr() && rollback.error.type).toBe("clock_rollback");

      const runtime = await clock.probeRuntimeChild();
      expect(runtime.isOk()).toBe(true);
      if (runtime.isErr()) return;
      expect(runtime.value.now).toBeLessThan(epoch);
    } finally {
      clock.dispose();
      child.kill("SIGTERM");
    }
  });

  it("returns typed protocol and closed-child failures and removes its listener", async () => {
    const spec = controlledClockSpawn(probe, Date.parse("2040-01-01T00:00:00.000Z"));
    const child = spawn("node", spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const before = child.listenerCount("message");
    const clock = attachControlledClock(child);
    expect(child.listenerCount("message")).toBe(before + 1);
    expect((await clock.ready).isOk()).toBe(true);
    expect((await clock.advanceTo(Number.NaN))._unsafeUnwrapErr().type).toBe(
      "invalid_clock_target",
    );
    clock.dispose();
    expect(child.listenerCount("message")).toBe(before);
    expect((await clock.advanceTo(Date.now()))._unsafeUnwrapErr().type).toBe("clock_closed");
    child.kill("SIGTERM");
  });
});

describe("effective OpenAI response instructions", () => {
  it("folds framed section updates over historical leading instructions", () => {
    const effective = effectiveOpenAIResponseInstructions({
      instructions:
        "base\n\n<project_context>\nPROJECT_FIRST\n</project_context>\n\n<cwd>\n/old\n</cwd>",
      input: [
        {
          role: "developer",
          content:
            'Updated system prompt section "project_context":\n\n<project_context>\nPROJECT_NEXT\n</project_context>\n\nUpdated system prompt section "cwd":\n\n<cwd>\n/new\n</cwd>',
        },
      ],
    });

    expect(effective).toContain("PROJECT_NEXT");
    expect(effective).toContain("/new");
    expect(effective).not.toContain("PROJECT_FIRST");
    expect(effective).not.toContain("/old");
  });

  it("folds removals without treating conversation input as instructions", () => {
    const effective = effectiveOpenAIResponseInstructions({
      instructions: "base\n\n<addendum>\nREMOVE_ME\n</addendum>",
      input: [
        { role: "developer", content: 'Removed system prompt section "addendum".' },
        { role: "user", content: [{ type: "input_text", text: "NOT_AN_INSTRUCTION" }] },
      ],
    });

    expect(effective).toBe("base");
  });
});

describe("fake request selection", () => {
  it("selects only new model requests and restores recorded order", () => {
    const before = [
      { id: 20, surface: "auth", body: { client_id: "old" } },
      { id: 19, surface: "model", body: { message: "old inference" } },
    ];
    const after = [
      { id: 25, surface: "model", body: { message: "wake notification" } },
      { id: 24, surface: "auth", body: { client_id: "new auth" } },
      { id: 23, surface: "model", body: { message: "Luna completion" } },
      { id: 22, surface: "model", body: { message: "combined wake context" } },
      ...before,
    ];

    expect(newModelRequestsById(after, requestIds(before))).toEqual([after[3], after[2], after[0]]);
  });
});

describe("fakeRequest", () => {
  it("retries a transport failure and returns the eventual response", async () => {
    let calls = 0;
    const response = await fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
      retryTransport: true,
      backoffMs: [0, 0],
      fetchImpl: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(connectionReset()) : Promise.resolve(ok());
      },
    });
    expect(calls).toBe(3);
    expect(response.status).toBe(200);
  });

  it("passes the request URL and body through", async () => {
    const seen: { url: string; method: string | undefined; body: string | undefined }[] = [];
    await fakeRequest("POST", "/api/__mock__/sessions", {
      body: { name: "x" },
      retryTransport: false,
      fetchImpl: (url, init) => {
        seen.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return Promise.resolve(ok());
      },
    });
    expect(seen).toEqual([
      {
        url: `${FAKE_ORIGIN}/api/__mock__/sessions`,
        method: "POST",
        body: '{"name":"x"}',
      },
    ]);
  });

  it("gives up after the bounded attempt count, naming the call", async () => {
    let calls = 0;
    const failure = await rejection(
      fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
        retryTransport: true,
        backoffMs: [0, 0],
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(connectionReset());
        },
      }),
    );
    expect(calls).toBe(3);
    expect(failure.message).toContain("GET /api/__mock__/sessions/s/requests");
    expect(failure.message).toContain("3 attempts");
    expect((failure.cause as Error | undefined)?.message).toBe("fetch failed");
  });

  it("does not retry a request that reached the service", async () => {
    let calls = 0;
    const response = await fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
      retryTransport: true,
      backoffMs: [0, 0],
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("boom", { status: 500 }));
      },
    });
    expect(calls).toBe(1);
    expect(response.status).toBe(500);
  });

  it("does not retry when retryTransport is off", async () => {
    let calls = 0;
    const failure = await rejection(
      fakeRequest("POST", "/api/__mock__/sessions/s/deviceauth/approve", {
        body: { user_code: "c" },
        retryTransport: false,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(connectionReset());
        },
      }),
    );
    expect(calls).toBe(1);
    expect(failure.message).toContain("1 attempt");
  });

  it("aborts a hung request at the deadline", async () => {
    const failure = await rejection(
      fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
        retryTransport: false,
        deadlineMs: 20,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason as Error);
            });
          }),
      }),
    );
    expect(failure.message).toContain("GET /api/__mock__/sessions/s/requests");
    expect((failure.cause as Error | undefined)?.name).toBe("TimeoutError");
  });
});

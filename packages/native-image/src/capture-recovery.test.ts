import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { type CommandRunner, GcloudImageBuildEffects } from "./gcloud.ts";
import { imageBuildInput } from "./testkit/image-build-input.ts";

const input = imageBuildInput();
const prefix = "https://www.googleapis.com/compute/v1/";
const name = "pi-orb-image-v1-0123456789abcdef";
const ready = {
  id: "2519867829670476835",
  name,
  selfLink: `${prefix}projects/${input.project}/global/images/${name}`,
  sourceDisk: `${prefix}projects/${input.project}/zones/${input.zone}/disks/pi-orb-builder-v1-0123456789abcdef`,
  labels: { "pi-orb-native-build": input.operationId, "pi-orb-native-version": input.version },
  status: "READY",
};

function commandFailure(action: "create" | "describe", body: string): Error {
  return Object.assign(new Error("command failed"), {
    stderr: `ERROR: (gcloud.compute.images.${action}) Could not fetch resource:\n - ${body}\n`,
  });
}

const lostResponse = () =>
  commandFailure(
    "create",
    "<!DOCTYPE html>\n<html lang=en>\n  <title>Error 502 (Server Error)!!1</title>\n",
  );
const transientRead = () => commandFailure("describe", "HTTPError 503: Service Unavailable");
const absent = () =>
  commandFailure(
    "describe",
    `The resource 'projects/${input.project}/global/images/${name}' was not found`,
  );

function harness(
  reads: (Error | object)[],
  options: { elapsed?: number; logFailure?: number } = {},
) {
  let now = 0;
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const logs: string[] = [];
  const abort = new AbortController();
  const runner: CommandRunner = async (_command, args, commandOptions) => {
    calls.push(args);
    timeouts.push(commandOptions.timeout);
    if (args[2] === "create") throw lostResponse();
    now += options.elapsed ?? 0;
    const response = reads.length > 1 ? reads.shift() : reads[0];
    if (response instanceof Error) throw response;
    return { stdout: JSON.stringify(response), stderr: "" };
  };
  const effects = new GcloudImageBuildEffects(
    runner,
    {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    },
    (_path, contents) => {
      logs.push(contents);
      return logs.length === options.logFailure
        ? errAsync({ type: "command_log_write_failed", message: "storage unavailable" })
        : okAsync(undefined);
    },
  );
  return { effects, calls, timeouts, logs, abort, now: () => now };
}

describe("native capture read-only recovery", () => {
  it("recovers a successful insert whose synchronous response was Google's HTML 502", async () => {
    const h = harness([ready]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isOk() && result.value.id).toBe(ready.id);
    expect(h.calls.map((args) => args[2])).toEqual(["create", "describe"]);
    expect(h.logs).toHaveLength(2);
  });

  it("retries transient describe failures and just-created absence without another create", async () => {
    const h = harness([transientRead(), absent(), { ...ready, status: "PENDING" }, ready]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isOk()).toBe(true);
    expect(h.calls.map((args) => args[2])).toEqual([
      "create",
      "describe",
      "describe",
      "describe",
      "describe",
    ]);
    expect(h.now()).toBe(15_000);
  });

  it("recovers workspace capture with its own exact source and image", async () => {
    const workspaceName = name.replace("image-", "image-workspace-");
    const h = harness([
      {
        ...ready,
        name: workspaceName,
        selfLink: ready.selfLink.replace(name, workspaceName),
        sourceDisk: ready.sourceDisk.replace("builder-", "data-workspace-"),
      },
    ]);
    const result = await h.effects.capture(input, "workspace", h.abort.signal);
    expect(result.isOk() && result.value.name).toBe(workspaceName);
    expect(h.calls[1]?.[3]).toBe(workspaceName);
  });

  it.each([transientRead(), absent(), { ...ready, status: "PENDING" }])(
    "exhausts one fixed deadline rather than renewing the budget (%j)",
    async (response) => {
      const h = harness([response], { elapsed: 7_000 });
      const result = await h.effects.capture(input, "runtime", h.abort.signal);
      expect(result.isErr() && result.error.message).toContain(
        "capture recovery deadline exceeded",
      );
      expect(h.now()).toBe(60_000);
      expect(h.calls.filter((args) => args[2] === "create")).toHaveLength(1);
      expect(h.timeouts.slice(1).every((timeout) => timeout <= 10_000)).toBe(true);
    },
  );

  it("pins the image id across PENDING polls", async () => {
    const h = harness([
      { ...ready, status: "PENDING" },
      { ...ready, id: "999" },
    ]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr()).toBe(true);
    expect(h.calls).toHaveLength(3);
  });

  it.each(["read", "wait", "log"] as const)(
    "cancels during %s without accepting success",
    async (phase) => {
      const abort = new AbortController();
      let commands = 0;
      let logs = 0;
      const result = await new GcloudImageBuildEffects(
        async () => {
          if (++commands === 1) throw lostResponse();
          if (phase === "read") abort.abort();
          return {
            stdout: JSON.stringify(phase === "wait" ? { ...ready, status: "PENDING" } : ready),
            stderr: "",
          };
        },
        {
          now: () => 0,
          wait: async () => {
            abort.abort();
          },
        },
        () => {
          if (++logs === 2 && phase === "log") abort.abort();
          return okAsync(undefined);
        },
      ).capture(input, "runtime", abort.signal);
      expect(result.isErr() && result.error.type).toBe("cancelled");
      expect(commands).toBe(2);
    },
  );

  it("preserves cancellation during the last bounded wait", async () => {
    const abort = new AbortController();
    let commands = 0;
    let waits = 0;
    const result = await new GcloudImageBuildEffects(
      async () => {
        if (++commands === 1) throw lostResponse();
        throw transientRead();
      },
      {
        now: () => 0,
        wait: async () => {
          if (++waits === 12) abort.abort();
        },
      },
      () => okAsync(undefined),
    ).capture(input, "runtime", abort.signal);
    expect(result.isErr() && result.error.type).toBe("cancelled");
    expect(commands).toBe(13);
  });

  it("counts delayed log persistence against recovery deadline", async () => {
    let now = 0;
    let commands = 0;
    const result = await new GcloudImageBuildEffects(
      async () => {
        if (++commands === 1) throw lostResponse();
        return { stdout: JSON.stringify(ready), stderr: "" };
      },
      { now: () => now, wait: async () => {} },
      () => {
        if (commands === 2) now = 60_000;
        return okAsync(undefined);
      },
    ).capture(input, "runtime", new AbortController().signal);
    expect(result.isErr() && result.error.message).toContain("capture recovery deadline exceeded");
  });

  it("bounds reads even if an injected clock does not progress", async () => {
    let commands = 0;
    const result = await new GcloudImageBuildEffects(
      async () => {
        if (++commands === 1) throw lostResponse();
        throw transientRead();
      },
      { now: () => 0, wait: async () => {} },
      () => okAsync(undefined),
    ).capture(input, "runtime", new AbortController().signal);
    expect(result.isErr()).toBe(true);
    expect(commands).toBe(13);
  });

  it.each([{ killed: true }, { code: "ETIMEDOUT" }, { signal: "SIGKILL" }])(
    "does not recover terminated command %j",
    async (termination) => {
      let calls = 0;
      const result = await new GcloudImageBuildEffects(
        async () => {
          calls++;
          throw Object.assign(lostResponse(), termination);
        },
        undefined,
        () => okAsync(undefined),
      ).capture(input, "runtime", new AbortController().signal);
      expect(result.isErr()).toBe(true);
      expect(calls).toBe(1);
    },
  );

  it.each([ready, { ...ready, name: "foreign" }, { ...ready, status: "PENDING" }])(
    "validates successful create response %j",
    async (body) => {
      let calls = 0;
      const result = await new GcloudImageBuildEffects(
        async () => {
          calls++;
          return { stdout: JSON.stringify([body]), stderr: "" };
        },
        undefined,
        () => okAsync(undefined),
      ).capture(input, "runtime", new AbortController().signal);
      expect(result.isOk()).toBe(body === ready);
      expect(calls).toBe(1);
    },
  );

  it("does not accept a READY response arriving after the deadline", async () => {
    const h = harness([ready], { elapsed: 60_001 });
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr() && result.error.message).toContain("capture recovery deadline exceeded");
  });

  it.each([
    { name: "foreign" },
    { selfLink: ready.selfLink.replace(input.project, "foreign") },
    { labels: { ...ready.labels, "pi-orb-native-build": "foreign" } },
    { labels: { ...ready.labels, "pi-orb-native-version": "foreign" } },
    { sourceDisk: ready.sourceDisk.replace(input.zone, "foreign-zone") },
    { sourceDisk: ready.sourceDisk.replace("builder", "foreign") },
    { id: "not-numeric" },
    { status: "FAILED" },
    { status: "DELETING" },
    { status: undefined },
  ])("rejects foreign or malformed recovery image %j", async (fields) => {
    const h = harness([{ ...ready, ...fields }]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr()).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(h.now()).toBe(0);
  });

  it.each(["read", "log"] as const)(
    "returns before a stuck %s and handles its late rejection",
    async (boundary) => {
      let started: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => {
        started = resolve;
      });
      let rejectLate: (reason: unknown) => void = () => {};
      const late = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      const budget = new AbortController();
      let timerCancelled = 0;
      let commands = 0;
      const resultPromise = new GcloudImageBuildEffects(
        async () => {
          if (++commands === 1) throw lostResponse();
          if (boundary === "read") {
            started();
            return late;
          }
          return { stdout: JSON.stringify(ready), stderr: "" };
        },
        {
          now: () => 0,
          wait: async () => {},
          createDeadline: () => ({
            signal: budget.signal,
            cancel: () => {
              timerCancelled++;
            },
          }),
        },
        () => {
          if (commands === 2 && boundary === "log") {
            started();
            return ResultAsync.fromPromise(late, () => ({
              type: "command_log_write_failed",
              message: "SECRET_SENTINEL",
            }));
          }
          return okAsync(undefined);
        },
      ).capture(input, "runtime", new AbortController().signal);
      await inFlight;
      budget.abort();
      const result = await resultPromise;
      expect(result.isErr() && result.error.message).toBe("capture recovery deadline exceeded");
      expect(timerCancelled).toBe(1);
      expect(commands).toBe(2);
      rejectLate(new Error("SECRET_SENTINEL"));
      await late.catch(() => {});
      await Promise.resolve();
      expect(commands).toBe(2);
    },
  );

  it("maps a throwing recovery wait to a fixed typed error", async () => {
    let commands = 0;
    const result = await new GcloudImageBuildEffects(
      async () => {
        if (++commands === 1) throw lostResponse();
        throw transientRead();
      },
      {
        now: () => 0,
        wait: () => {
          throw new Error("SECRET_SENTINEL");
        },
      },
      () => okAsync(undefined),
    ).capture(input, "runtime", new AbortController().signal);
    expect(result.isErr() && result.error.message).toBe(
      "capture recovery read failed; inspect private command log",
    );
  });

  it("keeps terminal read stderr out of public recovery errors", async () => {
    const failure = Object.assign(commandFailure("describe", "Permission denied SECRET_SENTINEL"), {
      message: "Command failed: gcloud SECRET_SENTINEL",
    });
    const h = harness([failure]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr() && result.error.message).toBe(
      "capture recovery read failed; inspect private command log",
    );
    expect(h.logs.some((log) => log.includes("SECRET_SENTINEL"))).toBe(true);
  });

  it("rejects nontransient read errors immediately", async () => {
    const h = harness([commandFailure("describe", "Permission denied")]);
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr()).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it.each([1, 2])("does not retry command-log failure at command %i", async (logFailure) => {
    const h = harness([ready], { logFailure });
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr() && result.error.message).toContain("failed to preserve command log");
    expect(h.calls).toHaveLength(logFailure);
  });

  it.each([
    new Error("HTTPError 502: unrelated message"),
    commandFailure("create", "Permission denied (502 in resource name)"),
    commandFailure("describe", "HTTPError 502: Bad Gateway"),
    commandFailure("create", "HTTPError 403: Permission denied"),
  ])("does not recover unclassified create errors %j", async (failure) => {
    let calls = 0;
    const result = await new GcloudImageBuildEffects(
      async () => {
        calls++;
        throw failure;
      },
      undefined,
      () => okAsync(undefined),
    ).capture(input, "runtime", new AbortController().signal);
    expect(result.isErr()).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not create or read after cancellation", async () => {
    const h = harness([ready]);
    h.abort.abort();
    const result = await h.effects.capture(input, "runtime", h.abort.signal);
    expect(result.isErr() && result.error.type).toBe("cancelled");
    expect(h.calls).toHaveLength(0);
  });

  it("emits fixed safe recovery decisions, not command output", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness([transientRead(), ready]);
      await h.effects.capture(input, "runtime", h.abort.signal);
      expect(log.mock.calls).toEqual([
        ["capture recovery: runtime started http=502"],
        ["capture recovery: runtime transient_read http=503"],
        ["capture recovery: runtime recovered"],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

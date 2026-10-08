import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { captureSubagentFailure, readFailureJson } from "./subagent-failure-evidence.ts";

it("saves bounded local metadata before independent probes and excludes private contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-evidence-unit-"));
  const orb = "c01e5202-cc89-468e-9b96-0123456789ab";
  const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "root.jsonl"),
    Array.from({ length: 100 }, () =>
      JSON.stringify({
        type: "custom",
        id: orb,
        customType: "pi-orb.subagent-run",
        data: {
          phase: "admitted",
          childId: orb.slice(0, 17),
          operationId: orb,
          description: "SECRET".repeat(100),
        },
        message: { content: "SECRET" },
      }),
    ).join("\n") + "\n",
  );
  mkdirSync(join(directory, "children"));
  writeFileSync(join(directory, "children", "private.jsonl"), JSON.stringify({ type: "SECRET" }));
  const artifact = join(root, "evidence", "failure.json");
  const seen: string[] = [];
  let localSnapshot: ReturnType<typeof JSON.parse>;
  try {
    const result = await captureSubagentFailure({
      root,
      orb,
      phase: "continuation",
      artifact,
      logs: [`lifecycle: orb=${orb} archive-waiting-for-work SECRET`, "SECRET"],
      probes: {
        health: async () => {
          localSnapshot = JSON.parse(readFileSync(artifact, "utf8"));
          seen.push("health");
          return {
            status: 200,
            body: { status: "ready", activity: "busy", operationId: orb, error: "SECRET" },
          };
        },
        orb: async () => {
          seen.push("orb");
          throw new Error("SECRET");
        },
        history: async () => {
          seen.push("history");
          return { status: 200, body: { records: [], content: "SECRET" } };
        },
        model: async () => {
          seen.push("model");
          throw new Error("SECRET");
        },
        names: async () => {
          seen.push("names");
          return {
            status: 200,
            body: Array.from({ length: 90 }, () => ({
              surface: "model",
              id: 2,
              matchedRuleIndex: 4,
              status: 200,
              body: "SECRET",
              events: Array.from({ length: 90 }, () => ({
                type: "response.completed",
                data: "SECRET",
              })),
            })),
          };
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(localSnapshot.root.entries).toHaveLength(30);
    expect(localSnapshot.root.truncated).toBe(true);
    expect(localSnapshot.lifecycle).toEqual(["archive-waiting-for-work"]);
    expect(localSnapshot.nativeAudit).toEqual({ state: "audit_missing" });
    expect(seen.sort()).toEqual(["health", "history", "model", "names", "orb"]);
    const text = readFileSync(artifact, "utf8");
    const saved = JSON.parse(text);
    expect(saved.probes.orb).toEqual({ unavailable: true });
    expect(saved.probes.model).toEqual({ unavailable: true });
    expect(saved.probes.health).toMatchObject({
      status: 200,
      runtimeStatus: "ready",
      activity: "busy",
      operationId: orb,
    });
    expect(saved.probes.names[0]).toMatchObject({
      id: 2,
      matchedRuleIndex: 4,
      status: 200,
      eventCounts: { "response.completed": 80 },
    });
    expect(saved.root.entries[0].childId).toBe(orb.slice(0, 17));
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(saved.probes.names).toHaveLength(30);
    expect(text).not.toContain("SECRET");
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains bounded stream and persisted audit metadata without payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-stream-evidence-unit-"));
  const orb = "c01e5202-cc89-468e-9b96-0123456789ab";
  const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
  mkdirSync(directory, { recursive: true });
  const stream = {
    requestId: orb,
    operationId: orb,
    sessionId: orb,
    parentSessionId: "SECRET",
    attempt: 2,
    startedAt: 100,
    firstEventAt: null,
    lastEventAt: 150,
    lastEventType: "response.completed",
    events: 4,
    phase: "waiting",
    transport: "sse",
    httpResponses: 1,
    httpStatus: 200,
    issues: ["no_event_gap", "SECRET"],
    edge: "terminal",
    observedAt: 200,
    terminal: "failed",
    prompt: "SECRET",
    token: "SECRET",
    error: "SECRET",
  };
  writeFileSync(
    join(directory, "root.jsonl"),
    JSON.stringify({ type: "custom", customType: "pi-orb.stream-audit", data: stream }),
  );
  const artifact = join(root, "failure.json");
  try {
    const result = await captureSubagentFailure({
      root,
      orb,
      phase: "profiles",
      artifact,
      logs: [],
      probes: {
        health: async () => ({
          status: 200,
          body: { streams: Array.from({ length: 40 }, () => stream) },
        }),
      },
    });
    expect(result.isOk()).toBe(true);
    const text = readFileSync(artifact, "utf8");
    const saved = JSON.parse(text);
    expect(saved.root.entries[0]).toMatchObject({
      customType: "pi-orb.stream-audit",
      stream: { requestId: orb, edge: "terminal", observedAt: 200, terminal: "failed" },
    });
    expect(saved.probes.health.streams).toHaveLength(30);
    expect(saved.probes.health.streams[0]).toMatchObject({
      requestId: orb,
      attempt: 2,
      startedAt: 100,
      firstEventAt: null,
      lastEventAt: 150,
      lastEventType: "response.completed",
      phase: "waiting",
      transport: "sse",
      httpStatus: 200,
      issues: ["no_event_gap"],
    });
    expect(text).not.toContain("SECRET");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reports an artifact write failure without issuing probes", async () => {
  let called = false;
  const result = await captureSubagentFailure({
    root: "/missing",
    orb: "invalid",
    phase: "profiles",
    artifact: "/dev/null/failure.json",
    logs: [],
    probes: {
      health: async () => {
        called = true;
        return {};
      },
    },
  });
  expect(result.isErr()).toBe(true);
  expect(called).toBe(false);
});

it("keeps local evidence while a JSON probe is held, then retains independent probes after its deadline", async () => {
  expect(typeof readFailureJson).toBe("function");
  const root = mkdtempSync(join(tmpdir(), "subagent-deadline-evidence-unit-"));
  const orb = "c01e5202-cc89-468e-9b96-0123456789ab";
  const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "root.jsonl"),
    JSON.stringify({
      type: "custom",
      customType: "subagents:record",
      data: { id: orb.slice(0, 17), status: "completed", content: "SECRET" },
    }),
  );
  const artifact = join(root, "failure.json");
  const deadline = new AbortController();
  let fetchStarted = () => {};
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetchProbe = vi.fn<typeof fetch>(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
        fetchStarted();
      }),
  );
  vi.stubGlobal("fetch", fetchProbe);
  let pending: ReturnType<typeof captureSubagentFailure> | undefined;
  try {
    pending = captureSubagentFailure({
      root,
      orb,
      artifact,
      phase: "continuation",
      logs: [],
      probes: {
        health: async () =>
          (await readFailureJson("http://127.0.0.1:1234/v1/health")).unwrapOr({
            unavailable: true,
          }),
        history: async () => ({ status: 500, body: { error: "SECRET" } }),
        model: async () => ({
          status: 200,
          body: [
            {
              surface: "model",
              id: 1,
              status: 400,
              matchedRuleIndex: null,
              body: JSON.stringify({ model: "gpt-6-luna", input: [], instructions: "SECRET" }),
              events: [
                { kind: "response", body: { error: "no_matching_rule", message: "SECRET" } },
              ],
            },
          ],
        }),
        names: async () => ({ status: 200, body: [] }),
      },
    });
    await started;
    const local = JSON.parse(readFileSync(artifact, "utf8"));
    expect(local.root.entries[0]).toMatchObject({ status: "completed" });
    expect(local.probes).toEqual({});
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000);
    rmSync(directory, { recursive: true, force: true });
    deadline.abort(new DOMException("SECRET", "TimeoutError"));
    expect((await pending).isOk()).toBe(true);
    const final = JSON.parse(readFileSync(artifact, "utf8"));
    expect(final.root).toEqual(local.root);
    expect(final.probes.health).toEqual({ unavailable: true });
    expect(final.probes.history).toEqual({ status: 500, unavailable: true });
    expect(final.probes.model[0]).toMatchObject({
      id: 1,
      matchedRuleIndex: null,
      status: 400,
      modelRequest: { model: "luna", inputCount: 0 },
      modelErrors: ["no_matching_rule"],
    });
    expect(final.probes.names).toEqual([]);
    expect(fetchProbe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(final)).not.toContain("SECRET");
  } finally {
    deadline.abort();
    if (pending) await pending;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains a failed HTTP status without decoding its error body", async () => {
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  const response = new Response("SECRET invalid JSON", { status: 500 });
  const decode = vi.spyOn(response, "json");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
  try {
    const result = await readFailureJson("http://127.0.0.1:1234/v1/history");
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr(null)).toEqual({ status: 500, body: {} });
    expect(decode).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("distinguishes unavailable history from a successful empty snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-history-evidence-unit-"));
  const orb = "c01e5202-cc89-468e-9b96-0123456789ab";
  const directory = join(root, "hosts", orb, "workspace", "pi-sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "root.jsonl"),
    JSON.stringify({
      type: "custom",
      customType: "subagents:record",
      data: { id: orb.slice(0, 17), status: "completed", text: "SECRET" },
    }),
  );
  const artifact = join(root, "failure.json");
  try {
    for (const status of [500, 200]) {
      const saved = await captureSubagentFailure({
        root,
        orb,
        artifact,
        phase: "continuation",
        logs: [],
        probes: {
          history: async () => ({
            status,
            body: status === 200 ? { records: [] } : { error: "SECRET" },
          }),
        },
      });
      expect(saved.isOk()).toBe(true);
      const bundle = JSON.parse(readFileSync(artifact, "utf8"));
      expect(bundle.root.entries[0]).toMatchObject({
        childId: orb.slice(0, 17),
        status: "completed",
      });
      if (status === 500) {
        expect(bundle.probes.history).toEqual({ status: 500, unavailable: true });
        expect(bundle.probes.history).not.toHaveProperty("recordCount");
      } else expect(bundle.probes.history).toMatchObject({ status: 200, recordCount: 0 });
      expect(JSON.stringify(bundle)).not.toContain("SECRET");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

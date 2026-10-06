import { readFileSync } from "node:fs";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  type ResourceSnapshot,
  resourceError,
} from "../apps/control-plane/src/domain/resources.ts";
import {
  afterAcquireGate,
  CROSS_AXIS_CASES,
  issuedDeviceLoginChallenge,
  localGitEnvironment,
} from "./testkit/cross-axis.ts";

const snapshot: ResourceSnapshot = {
  orbId: "orb",
  commitSha: "a".repeat(40),
  instructionPath: null,
  skillRoot: null,
  files: [],
};

describe("cross-axis acceptance contracts", () => {
  it("registers independent explicit backend/provider compositions", () => {
    expect(CROSS_AXIS_CASES).toEqual([
      { provider: "process", agentBackend: "central-durable", movingMain: true },
      { provider: "process", agentBackend: "host-pi", movingMain: false },
      { provider: "docker", agentBackend: "central-durable", movingMain: false },
    ]);
  });
  it("holds the resolved immutable snapshot before publication", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: string | undefined;
    const source = afterAcquireGate({ acquire: () => okAsync(snapshot) }, (value) => {
      seen = value.commitSha;
      return ResultAsync.fromSafePromise(held);
    });
    let published = false;
    const acquiring = source
      .acquire({
        orbId: "orb",
        url: "https://github.com/example/repo",
        signal: new AbortController().signal,
      })
      .map(() => {
        published = true;
        return undefined;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toBe(snapshot.commitSha);
    expect(published).toBe(false);
    release();
    expect((await acquiring).isOk()).toBe(true);
    expect(published).toBe(true);
  });
  it("does not gate failed acquisition or publish after cancellation", async () => {
    let calls = 0;
    const failed = afterAcquireGate(
      { acquire: () => errAsync(resourceError("fetch", "failed")) },
      () => {
        calls++;
        return okAsync(undefined);
      },
    );
    const input = {
      orbId: "orb",
      url: "https://github.com/example/repo",
      signal: new AbortController().signal,
    };
    expect((await failed.acquire(input)).isErr()).toBe(true);
    expect(calls).toBe(0);
    const abort = new AbortController();
    const cancelled = afterAcquireGate({ acquire: () => okAsync(snapshot) }, () => {
      abort.abort();
      return okAsync(undefined);
    });
    const result = await cancelled.acquire({ ...input, signal: abort.signal });
    expect(result.isErr() && result.error.code).toBe("cancelled");
  });
  it("uses standard inherited Git rewrite slots, not relaxed production URLs", () => {
    expect(localGitEnvironment("/tmp/fixture", "https://github.com/example/repo")).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "url.file:///tmp/fixture.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/example/repo",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    });
  });
  it("does not approve a preparing placeholder while device-code issuance is held", async () => {
    let release!: (action: { type: string; userCode: string }) => void;
    const issuance = new Promise<{ type: string; userCode: string }>((resolve) => {
      release = resolve;
    });
    let action = { type: "openai_codex_device_login", userCode: "" };
    const issuing = issuance.then((issued) => {
      action = issued;
    });
    const approved: string[] = [];
    const poll = () => {
      const ready = issuedDeviceLoginChallenge(action);
      if (ready !== null) approved.push(ready.userCode);
    };
    expect(action.userCode ?? null).toBe("");
    poll();
    await Promise.resolve();
    poll();
    expect(approved).toEqual([]);
    expect(
      issuedDeviceLoginChallenge({ type: "github_device_login", userCode: "CODE" }),
    ).toBeNull();
    release({ type: "openai_codex_device_login", userCode: "CODE" });
    await issuing;
    poll();
    expect(approved).toEqual(["CODE"]);
  });
  it("uses production main and a post-acquire seam only", () => {
    const entry = readFileSync(
      new URL("./cross-axis-control-plane-entry.ts", import.meta.url),
      "utf8",
    );
    expect(entry).toMatch(/void main\(\{\s*resourceSource:/);
    expect(entry).toContain("afterAcquireGate(source");
    expect(entry).not.toContain("provisionHost:");
  });
});

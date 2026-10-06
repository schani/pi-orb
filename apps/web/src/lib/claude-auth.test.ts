import type { ClaudeAuthView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "./api.ts";
import { ClaudeAuthController } from "./claude-auth.ts";

describe("owner Claude connection", () => {
  function fixture() {
    let visible = true;
    const read = vi.fn(
      async (_signal: AbortSignal): Promise<Result<ClaudeAuthView, ApiError>> =>
        ok({ status: "disconnected" }),
    );
    const write = vi.fn(
      async (
        _action: string,
        _code: string | undefined,
        _signal: AbortSignal,
      ): Promise<Result<ClaudeAuthView, ApiError>> =>
        ok({ status: "connecting", challenge: { needsCode: true } }),
    );
    const scheduled: (() => void)[] = [];
    const controller = new ClaudeAuthController({
      read,
      write,
      visible: () => visible,
      schedule: (fn) => {
        scheduled.push(fn);
        return () => {
          scheduled.splice(scheduled.indexOf(fn), 1);
        };
      },
    });
    return {
      controller,
      read,
      write,
      scheduled,
      hide: () => {
        visible = false;
        controller.visibilityChanged();
      },
      show: () => {
        visible = true;
        controller.visibilityChanged();
      },
    };
  }
  it("loads owner state and never polls disconnected state", async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.snapshot.view?.status).toBe("disconnected");
    expect(f.scheduled).toHaveLength(0);
    f.controller.dispose();
  });
  it("connects, submits only a completion code, clears code, and cancels polling", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.act("connect");
    expect(f.scheduled).toHaveLength(1);
    await f.controller.act("code", "completion-code");
    expect(f.write.mock.calls[1]?.slice(0, 2)).toEqual(["code", "completion-code"]);
    expect(JSON.stringify(f.controller.snapshot)).not.toContain("completion-code");
    await f.controller.act("cancel");
    expect(f.write.mock.calls[2]?.[0]).toBe("cancel");
    f.controller.dispose();
    expect(f.scheduled).toHaveLength(0);
  });
  it("keeps accepted completion visibly in progress through stale challenge polls", async () => {
    const f = fixture();
    await f.controller.act("connect");
    await f.controller.act("code", "completion-code");
    expect(f.controller.snapshot.completing).toBe(true);
    expect(f.controller.snapshot.pending).toBe(false);
    f.read.mockImplementationOnce(async () =>
      ok({ status: "connecting", challenge: { needsCode: true } }),
    );
    await f.controller.start();
    expect(f.controller.snapshot.completing).toBe(true);
    await f.controller.act("code", "duplicate-code");
    expect(f.write).toHaveBeenCalledTimes(2);
    f.read.mockImplementationOnce(async () => ok({ status: "connected", generation: 1 }));
    await f.controller.start();
    expect(f.controller.snapshot.completing).toBe(false);
    f.controller.dispose();
  });
  it("retains submission errors until explicit retry without claiming completion", async () => {
    const f = fixture();
    await f.controller.act("connect");
    f.write.mockImplementationOnce(async () => err({ type: "network", message: "offline" }));
    await f.controller.act("code", "completion-code");
    expect(f.controller.snapshot.completing).toBe(false);
    expect(f.controller.snapshot.error).toContain("offline");
    expect(f.scheduled).toHaveLength(0);
    f.controller.dispose();
  });
  it("keeps waiting after a status read failure and exposes native terminal failures", async () => {
    const f = fixture();
    await f.controller.act("connect");
    await f.controller.act("code", "completion-code");
    f.read.mockImplementationOnce(async () => err({ type: "network", message: "offline" }));
    await f.controller.start();
    expect(f.controller.snapshot.completing).toBe(true);
    expect(f.controller.snapshot.error).toContain("offline");
    f.read.mockImplementationOnce(async () =>
      ok({ status: "failed", error: "Claude sign-in failed; reconnect" }),
    );
    await f.controller.start();
    expect(f.controller.snapshot.completing).toBe(false);
    expect(f.controller.snapshot.view?.error).toBe("Claude sign-in failed; reconnect");
    expect(f.scheduled).toHaveLength(0);
    f.controller.dispose();
  });
  it("aborts hidden reads and fences late responses", async () => {
    const f = fixture();
    let complete!: (value: Result<ClaudeAuthView, ApiError>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.controller.start();
    f.hide();
    expect(f.read.mock.calls[0]?.[0].aborted).toBe(true);
    complete(ok({ status: "connected" }));
    await pending;
    expect(f.controller.snapshot.view).toBeNull();
    f.show();
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });
  it("never overlaps polls and mutation completion fences a late owner read", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.act("connect");
    let complete!: (value: Result<ClaudeAuthView, ApiError>) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.controller.start();
    await f.controller.start();
    expect(f.read).toHaveBeenCalledTimes(2);
    await f.controller.act("disconnect");
    expect(f.read.mock.calls[1]?.[0].aborted).toBe(true);
    complete(ok({ status: "connected" }));
    await pending;
    expect(f.controller.snapshot.view?.status).toBe("connecting");
    f.controller.dispose();
  });
  it("stops failed polling and permits an explicit status retry", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.act("connect");
    f.read.mockImplementationOnce(async () => err({ type: "network", message: "offline" }));
    await f.controller.start();
    expect(f.controller.snapshot.error).toContain("offline");
    expect(f.scheduled).toHaveLength(0);
    await f.controller.start();
    expect(f.controller.snapshot.error).toBeNull();
    f.controller.dispose();
  });
  it("reports failures and does not retry unauthorized owner reads", async () => {
    const f = fixture();
    f.read.mockImplementationOnce(async () =>
      err({
        type: "http",
        status: 403,
        code: "forbidden",
        message: "Not your connection",
        retryable: false,
      }),
    );
    await f.controller.start();
    expect(f.controller.snapshot.error).toContain("Not your connection");
    expect(f.controller.snapshot.view).toBeNull();
    expect(f.scheduled).toHaveLength(0);
    f.controller.dispose();
  });
});

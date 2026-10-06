import type { ClaudeAuthView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { ApiError } from "./api.ts";
import { ClaudeAuthController } from "./claude-auth.ts";
import type { ConsentWindow } from "./claude-consent-window.ts";

const challenge: ClaudeAuthView = {
  status: "connecting",
  challenge: { url: "https://claude.ai/consent", needsCode: true },
};
function fixture(view: ClaudeAuthView = { status: "disconnected" }) {
  const read = vi.fn(async (): Promise<Result<ClaudeAuthView, ApiError>> => ok(view));
  const write = vi.fn(async (): Promise<Result<ClaudeAuthView, ApiError>> => ok(challenge));
  const popup: ConsentWindow = {
    navigate: vi.fn(() => ok(undefined)),
    close: vi.fn(() => ok(undefined)),
  };
  let visible = true;
  const scheduled: (() => void)[] = [];
  const controller = new ClaudeAuthController({
    read,
    write,
    visible: () => visible,
    schedule: (callback) => {
      const run = () => {
        scheduled.splice(scheduled.indexOf(run), 1);
        callback();
      };
      scheduled.push(run);
      return () => {
        const index = scheduled.indexOf(run);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  });
  return {
    controller,
    read,
    write,
    popup,
    scheduled,
    hide() {
      visible = false;
      controller.visibilityChanged();
    },
  };
}
it("one explicit entry reads then connects once and navigates once", async () => {
  const f = fixture();
  expect(f.read).not.toHaveBeenCalled();
  await f.controller.enter(ok(f.popup));
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.write).toHaveBeenCalledWith("connect", undefined, expect.any(AbortSignal));
  expect(f.popup.navigate).toHaveBeenCalledExactlyOnceWith("https://claude.ai/consent");
  f.read.mockResolvedValue(ok(challenge));
  await f.controller.start();
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it("reuses active consent without replacing its completion code", async () => {
  const f = fixture(challenge);
  await f.controller.enter(ok(f.popup));
  expect(f.write).not.toHaveBeenCalled();
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it("connecting without a challenge waits for polling, never reconnects", async () => {
  const f = fixture({ status: "connecting" });
  await f.controller.enter(ok(f.popup));
  expect(f.write).not.toHaveBeenCalled();
  expect(f.popup.navigate).not.toHaveBeenCalled();
  f.read.mockResolvedValue(ok(challenge));
  await f.controller.start();
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it.each(["during admission", "after admission"])(
  "polls a delayed native URL while the reserved tab hides the app %s, then pauses",
  async (timing) => {
    const f = fixture();
    f.write.mockResolvedValue(ok({ status: "connecting" }));
    const entry = f.controller.enter(ok(f.popup));
    if (timing === "during admission") f.hide();
    await entry;
    if (timing === "after admission") f.hide();
    expect(f.controller.snapshot.view).toEqual({ status: "connecting" });
    expect(f.scheduled).toHaveLength(1);
    f.read.mockResolvedValue(ok(challenge));
    f.scheduled[0]?.();
    await vi.waitFor(() => expect(f.popup.navigate).toHaveBeenCalledTimes(1));
    expect(f.scheduled).toHaveLength(0);
    await f.controller.start();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  },
);
it("hidden pending-launch polls remain fenced by disposal without owner cancellation", async () => {
  const f = fixture();
  f.write.mockResolvedValue(ok({ status: "connecting" }));
  await f.controller.enter(ok(f.popup));
  f.hide();
  expect(f.scheduled).toHaveLength(1);
  let resolve!: (value: Result<ClaudeAuthView, ApiError>) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  f.scheduled[0]?.();
  expect(f.read).toHaveBeenCalledTimes(2);
  f.controller.dispose();
  resolve(ok(challenge));
  await Promise.resolve();
  expect(f.popup.navigate).not.toHaveBeenCalled();
  expect(f.scheduled).toHaveLength(0);
  expect(f.write).toHaveBeenCalledTimes(1);
});
it("accepted code with no challenge cannot trigger a new connection", async () => {
  const f = fixture(challenge);
  await f.controller.enter(ok(f.popup));
  f.write.mockResolvedValue(ok({ status: "connecting" }));
  await f.controller.act("code", "synthetic-code");
  f.read.mockResolvedValue(ok({ status: "connecting" }));
  await f.controller.start();
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot.completing).toBe(true);
  f.controller.dispose();
});
it("connected entry opens management only and closes its unused reserved tab", async () => {
  const f = fixture({ status: "connected", generation: 1 });
  await f.controller.enter(ok(f.popup));
  expect(f.write).not.toHaveBeenCalled();
  expect(f.popup.navigate).not.toHaveBeenCalled();
  expect(f.popup.close).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot.view?.status).toBe("connected");
  f.controller.dispose();
});
it("explicit reconnect reserves a new launch and replaces once", async () => {
  const f = fixture({ status: "connected", generation: 1 });
  await f.controller.start();
  await f.controller.enter(ok(f.popup), true);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it("blocked and closed popups expose typed failures while retaining direct consent", async () => {
  const blocked = fixture();
  await blocked.controller.enter(err({ type: "popup_blocked" }));
  expect(blocked.controller.snapshot.launchError).toEqual({ type: "popup_blocked" });
  expect(blocked.controller.snapshot.view).toEqual(challenge);
  blocked.controller.dispose();
  const closed = fixture();
  vi.mocked(closed.popup.navigate).mockReturnValue(err({ type: "popup_closed" }));
  await closed.controller.enter(ok(closed.popup));
  expect(closed.controller.snapshot.launchError).toEqual({ type: "popup_closed" });
  expect(closed.controller.snapshot.view).toEqual(challenge);
  closed.controller.dispose();
});
it("native failure closes reserved consent and stays visible without automatic retries", async () => {
  const f = fixture();
  f.write.mockResolvedValue(ok({ status: "failed", error: "Sign-in expired" }));
  await f.controller.enter(ok(f.popup));
  expect(f.popup.close).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot.view?.error).toBe("Sign-in expired");
  expect(f.write).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it("unmount fences late owner state before it can create or navigate a ceremony", async () => {
  const f = fixture();
  let resolve!: (value: Result<ClaudeAuthView, ApiError>) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const entry = f.controller.enter(ok(f.popup));
  f.controller.dispose();
  resolve(ok({ status: "disconnected" }));
  await entry;
  expect(f.write).not.toHaveBeenCalled();
  expect(f.popup.navigate).not.toHaveBeenCalled();
  expect(f.popup.close).toHaveBeenCalledTimes(1);
});
it("close fences a late native URL without implicitly cancelling owner authentication", async () => {
  const f = fixture();
  let resolve!: (value: Result<ClaudeAuthView, ApiError>) => void;
  f.write.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const entry = f.controller.enter(ok(f.popup));
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledTimes(1));
  f.controller.dispose();
  resolve(ok(challenge));
  await entry;
  expect(f.popup.navigate).not.toHaveBeenCalled();
  expect(f.write.mock.calls).toHaveLength(1);
});
it("hidden consent tab does not abort explicit entry admission", async () => {
  const f = fixture();
  let resolve!: (value: Result<ClaudeAuthView, ApiError>) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const entry = f.controller.enter(ok(f.popup));
  f.hide();
  resolve(ok({ status: "disconnected" }));
  await entry;
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.popup.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});
it("failed reads stay failed until explicit entry retry", async () => {
  const f = fixture();
  f.read.mockResolvedValueOnce(err({ type: "network", message: "offline" }));
  await f.controller.enter(ok(f.popup));
  expect(f.popup.close).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.controller.snapshot.error).toContain("offline");
  const next: ConsentWindow = {
    navigate: vi.fn(() => ok(undefined)),
    close: vi.fn(() => ok(undefined)),
  };
  await f.controller.enter(ok(next));
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(next.navigate).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});

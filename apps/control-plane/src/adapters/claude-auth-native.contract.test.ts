import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  exited: Promise.resolve() as Promise<void>,
  root: "",
  diagnostics: {
    writes: 0,
    maskSeen: false,
    cursorAfterMask: false,
    challengeSeen: false,
    urlSeen: false,
  },
}));

// Interpose only the kernel guard; exercise the production transport and pinned CLI.
vi.mock("node-pty", async (importOriginal) => {
  const native = await importOriginal<typeof import("node-pty")>();
  return {
    ...native,
    spawn: (command: string, args: string[], options: import("node-pty").IPtyForkOptions) => {
      const child = native.spawn(
        "/usr/bin/python3",
        [
          fileURLToPath(
            new URL("../../../../scripts/claude-sdk-contract/network-guard.py", import.meta.url),
          ),
          command,
          ...args,
        ],
        { ...options, env: { ...options.env, NATIVE_CONTRACT_PORT: "-1" } },
      );
      state.root = options.cwd ?? "";
      state.diagnostics = {
        writes: 0,
        maskSeen: false,
        cursorAfterMask: false,
        challengeSeen: false,
        urlSeen: false,
      };
      child.onData((chunk) => {
        state.diagnostics.maskSeen ||= /\*{2,}/.test(chunk);
        state.diagnostics.cursorAfterMask ||=
          state.diagnostics.maskSeen && chunk.includes("\u001b[1A");
      });
      const write = child.write.bind(child);
      child.write = (data) => {
        state.diagnostics.writes++;
        write(data);
      };
      state.exited = new Promise((resolve) => {
        child.onExit(() => resolve());
      });
      return child;
    },
  };
});

import type { ClaudeAuthEvent } from "../domain/claude-auth.ts";
import { ClaudePtyAuthTransport } from "./claude-auth-pty.ts";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "cancellation drains the genuine native helper and removes its scratch home under kernel network denial",
  async () => {
    let challengeSeen!: () => void;
    let sawChallenge = false;
    const challenged = new Promise<void>((resolve) => {
      challengeSeen = resolve;
    });
    const session = (
      await new ClaudePtyAuthTransport().start((event) => {
        if ("challenge" in event && event.challenge.needsCode) {
          sawChallenge = true;
          challengeSeen();
        }
      })
    )._unsafeUnwrap();
    const deadline = setTimeout(challengeSeen, 10_000);
    try {
      await challenged;
      expect(sawChallenge).toBe(true);
      expect(session.cancel().isOk()).toBe(true);
      expect((await session.drain()).isOk()).toBe(true);
      await state.exited;
      expect((await ResultAsync.fromPromise(access(state.root), () => "removed")).isErr()).toBe(
        true,
      );
    } finally {
      clearTimeout(deadline);
      session.cancel();
      await session.drain();
    }
  },
  15_000,
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64").each([5, 100])(
  "submits a synthetic %i-character code through the genuine pinned CLI under kernel network denial",
  async (codeLength) => {
    const events: ClaudeAuthEvent[] = [];
    let tokenSeen = false;
    let settle: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session = (
      await new ClaudePtyAuthTransport().start((event) => {
        // Never retain the private challenge or raw output in assertion diagnostics.
        if ("challenge" in event) state.diagnostics.challengeSeen = true;
        if ("challenge" in event && event.challenge.url) {
          state.diagnostics.urlSeen = true;
          const nativeState = new URL(event.challenge.url).searchParams.get("state");
          if (nativeState?.length === 43)
            session.sendCode(`${"x".repeat(codeLength)}#${nativeState}`);
        } else if ("token" in event) {
          tokenSeen = true;
          settle?.();
        } else {
          events.push(event);
          if ("error" in event) settle?.();
        }
      })
    )._unsafeUnwrap();
    const deadline = setTimeout(() => settle?.(), 10_000);
    try {
      await terminal;
      expect(state.diagnostics).toMatchObject({
        writes: 2,
        maskSeen: true,
        challengeSeen: true,
        urlSeen: true,
      });
      expect(events).toContainEqual({ progress: "input_completed" });
      expect(events).toContainEqual({
        error: "Claude sign-in network request failed",
        stage: "native_exchange",
        reason: "network",
      });
      expect(tokenSeen).toBe(false);
    } finally {
      clearTimeout(deadline);
      session.cancel();
      expect((await session.drain()).isOk()).toBe(true);
      await state.exited;
      expect((await ResultAsync.fromPromise(access(state.root), () => "removed")).isErr()).toBe(
        true,
      );
    }
  },
  15_000,
);

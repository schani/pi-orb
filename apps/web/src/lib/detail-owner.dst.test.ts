import type { CommittedDisplayDetail } from "@pi-orb/protocol";
import { ok, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { initialState, reducer } from "../pages/OrbPage.tsx";
import { history } from "../testkit/transcript.ts";
import { DetailLoader } from "./detail-loader.ts";
import { TranscriptCache } from "./transcript-cache.ts";

const detail = (text: string): CommittedDisplayDetail => ({
  v: 1,
  sessionId: "session",
  state: "committed",
  recordId: "one",
  detailKey: "one:0",
  body: { type: "reasoning", text },
});

it("DST: final committed ref beats an earlier running response and alone enters shared cache", async () => {
  await runDst({ name: "lazy-detail-commit", iterations: 35 }, async (sim) => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    owner.publish(reducer(initialState("a"), { type: "history_loaded", view: history() }));
    let visible = "";
    const pending = new Map<string, (result: Result<CommittedDisplayDetail, string>) => void>();
    let oldStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const loader = new DetailLoader({
      read: (key: string) =>
        new Promise<Result<CommittedDisplayDetail, string>>((resolve) => {
          pending.set(key, resolve);
          if (key === "running") oldStarted();
        }),
      publish: (result) => {
        if (result.isErr()) return;
        expect(owner.publishDetail(result.value)).toBe("stored");
        if (result.value.body.type === "reasoning") visible = result.value.body.text;
      },
    });
    const result = await sim.runTasks([
      {
        name: "commit",
        f: async (task) => {
          loader.open("running", true);
          expect(pending.has("running")).toBe(true);
          await task.checkpoint("commit before old response");
          loader.open("one:0", false);
          expect(pending.has("one:0")).toBe(true);
          pending.get("one:0")?.(ok(detail("final")));
          await Promise.resolve();
          expect(visible).toBe("final");
        },
      },
      {
        name: "old running read",
        f: async (task) => {
          await ready;
          await task.checkpoint("old response");
          const old = pending.get("running");
          expect(old).toBeDefined();
          old?.(ok(detail("stale")));
          await Promise.resolve();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(visible).toBe("final");
    expect(cache.getDetail("a", "session", "one", "one:0")?.body).toEqual(detail("final").body);
    loader.close();
  });
});

it("DST: navigation/deletion fence running HTTP detail response from both visible state and shared cache", async () => {
  await runDst({ name: "lazy-detail-cache-owner", iterations: 35 }, async (sim) => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    const state = reducer(initialState("a"), { type: "history_loaded", view: history() });
    expect(owner.publish(state)).toBe("stored");
    let visible: string | null = null;
    let active = true;
    let release!: (result: Result<CommittedDisplayDetail, string>) => void;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let deleted!: () => void;
    const deletionDone = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const loader = new DetailLoader({
      read: () =>
        new Promise<Result<CommittedDisplayDetail, string>>((resolve) => {
          release = resolve;
          started();
        }),
      publish: (result) => {
        if (!active || result.isErr()) return;
        if (
          result.value.sessionId !== state.sessionId ||
          owner.publishDetail(result.value) === "stale"
        )
          return;
        visible = result.value.body.type === "reasoning" ? result.value.body.text : null;
      },
    });
    const result = await sim.runTasks([
      {
        name: "read",
        f: async (task) => {
          loader.open("one:0", false);
          await task.checkpoint("HTTP pending");
          await readStarted;
          expect(release).toBeDefined();
          await deletionDone;
          release(ok(detail("old secret")));
          await Promise.resolve();
        },
      },
      {
        name: "navigate-delete",
        f: async (task) => {
          await readStarted;
          await task.checkpoint("invalidate owner");
          active = false;
          loader.close();
          cache.invalidate("a");
          expect(owner.publishDetail(detail("late"))).toBe("stale");
          deleted();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(visible).toBeNull();
    expect(cache.getDetail("a", "session", "one", "one:0")).toBeUndefined();
  });
});

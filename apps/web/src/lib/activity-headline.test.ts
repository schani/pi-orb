import { describe, expect, it, vi } from "vitest";
import { HeadlineLimiter, selectToolHeadline } from "./activity-headline.ts";

const call = { detailKey: "call:0", name: "invented_fixture_tool", headline: null };
describe("generic headline sources", () => {
  it("accepts null, strings and empty strings without tool-name policy; absent is unsupported", () => {
    for (const headline of [null, "Ready", ""] as const) {
      expect(selectToolHeadline({ ...call, headline }, "call-record")).toEqual({
        recordId: "call-record",
        detailKey: "call:0",
        headline,
      });
    }
    expect(selectToolHeadline({ detailKey: "call:0" }, "call-record")).toBeUndefined();
  });
  it("selects result field presence over intent, but absent acknowledgement retains intent", () => {
    for (const headline of [null, "Outcome", ""] as const) {
      expect(
        selectToolHeadline(
          call,
          "call-record",
          { detailKey: "result:0", headline },
          "result-record",
        ),
      ).toEqual({
        recordId: "result-record",
        detailKey: "result:0",
        headline,
      });
    }
    expect(selectToolHeadline(call, "call-record", { detailKey: "ack:0" }, "ack-record")).toEqual({
      recordId: "call-record",
      detailKey: "call:0",
      headline: null,
    });
  });
});
describe("view headline slots", () => {
  it("caps at two, releases once, and removes unmounted queued headers before launch", () => {
    const pool = new HeadlineLimiter();
    const releases: Array<() => void> = [];
    const start = vi.fn((release: () => void) => releases.push(release));
    pool.enqueue(start);
    pool.enqueue(start);
    const cancel = pool.enqueue(start);
    expect(start).toHaveBeenCalledTimes(2);
    cancel();
    releases[0]?.();
    releases[0]?.();
    expect(start).toHaveBeenCalledTimes(2);
    pool.enqueue(start);
    expect(start).toHaveBeenCalledTimes(3);
    pool.enqueue(start);
    expect(start).toHaveBeenCalledTimes(3);
    releases[1]?.();
    expect(start).toHaveBeenCalledTimes(4);
  });
});

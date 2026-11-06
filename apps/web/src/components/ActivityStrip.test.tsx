import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ActivityItem, type ActivityStepState, groupActivity } from "./ActivityStrip.tsx";
import { toolCallStep } from "./ToolActivity.tsx";

function step(key: string, state: ActivityStepState): ActivityItem {
  const node = <p>row {key}</p>;
  return { key, node, step: { key, identity: key, node, state, label: "codemode", headline: key } };
}
const boundary = (key: string): ActivityItem => ({ key, node: <p>prose {key}</p> });
const render = (items: ActivityItem[]) => renderToStaticMarkup(<>{groupActivity(items)}</>);
const states = (html: string) => [...html.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);

describe("groupActivity", () => {
  it("leaves a lone step as its own row", () => {
    const html = render([step("a", "success")]);
    expect(html).toBe("<p>row a</p>");
  });

  it("folds consecutive steps into one strip with a dot per step in order", () => {
    const html = render([
      step("a", "thinking"),
      step("b", "success"),
      step("c", "failed"),
      step("d", "running"),
    ]);
    expect(states(html)).toEqual(["thinking", "success", "failed", "running"]);
    expect(html).toContain('<span class="activity-rail-metric">4</span>');
    expect(html).toContain("activity-rail-row-running activity-strip");
    expect(html).not.toContain("<p>row a</p>");
  });

  it("splits strips at items without a step", () => {
    const html = render([
      step("a", "thinking"),
      step("b", "success"),
      boundary("x"),
      step("c", "thinking"),
      step("d", "success"),
    ]);
    const [before, after] = html.split("<p>prose x</p>");
    expect(states(before ?? "")).toEqual(["thinking", "success"]);
    expect(states(after ?? "")).toEqual(["thinking", "success"]);
    expect(before).not.toContain("activity-rail-row-running");
  });
});

describe("ActivityStrip open memory", () => {
  it("reopens a strip whose step was opened under its live alias", () => {
    const memory = { aliases: new Map([["record:2", "live-block"]]), opened: new Set<string>() };
    const persisted = [step("record:2", "thinking"), step("record:3", "thinking")];
    expect(render(persisted)).not.toContain("<p>row record:2</p>");
    memory.opened.add("strip:live-block");
    const html = renderToStaticMarkup(<>{groupActivity(persisted, memory)}</>);
    expect(html).toMatch(/<details class="[^"]*activity-strip" open="">/);
    expect(html).toContain("<p>row record:2</p>");
  });
});

describe("toolCallStep", () => {
  const call = (callId: string) => ({
    type: "tool_call" as const,
    callId,
    name: "codemode",
    code: `run ${callId}`,
    detailKey: `${callId}:0`,
  });
  const result = (callId: string, extra: object = {}) => ({
    type: "tool_result" as const,
    callId,
    hasImages: false,
    detailKey: `${callId}:r`,
    ...extra,
  });

  it("reports one call's state, category and code", () => {
    expect(toolCallStep({ call: call("a"), callRecordId: "r", result: result("a") })).toEqual({
      state: "success",
      label: "codemode",
      headline: "run a",
    });
    expect(
      toolCallStep({ call: call("b"), callRecordId: "r", result: result("b", { isError: true }) })
        ?.state,
    ).toBe("failed");
    expect(toolCallStep({ call: call("c"), callRecordId: "r" })?.state).toBe("running");
    expect(toolCallStep({ callId: "d", name: "bash", state: "running" })).toEqual({
      state: "running",
      label: "commands",
      headline: "bash",
    });
  });

  it("keeps calls with images or charts out of the strip", () => {
    expect(
      toolCallStep({
        call: call("a"),
        callRecordId: "r",
        result: result("a", { hasImages: true }),
      }),
    ).toBeUndefined();
    expect(
      toolCallStep({ call: call("a"), callRecordId: "r", result: result("a", { charts: ["c"] }) }),
    ).toBeUndefined();
  });
});

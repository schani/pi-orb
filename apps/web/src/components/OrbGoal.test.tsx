import type { GoalView, HarnessKind } from "@pi-orb/protocol";
import {
  type KeyboardEvent,
  type ReactElement,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { OrbGoal } from "./OrbGoal.tsx";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

let input: TextareaHTMLAttributes<HTMLTextAreaElement>;
vi.mock("./TextFieldFrame.tsx", () => ({
  TextFieldFrame: ({ children }: { children: ReactElement }) => {
    input = children.props as TextareaHTMLAttributes<HTMLTextAreaElement>;
    return children;
  },
}));

function render(status: GoalView["status"], writable = true, harness: HarnessKind = "pi") {
  return renderToStaticMarkup(
    <OrbGoal
      goal={{ revision: "rev", objective: "Ship the fix", status, reason: "Needs review" }}
      harness={harness}
      writable={writable}
      pending={false}
      error={null}
      onChange={() => {}}
      onClose={() => {}}
    />,
  );
}

it("puts the objective before the status in a collapsed native disclosure", () => {
  const markup = render("active");
  expect(markup).toMatch(/<details[^>]*><summary[^>]*>.*Ship the fix.*active.*<\/summary>/);
  expect(markup).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
  expect(markup).toContain(">Pause</button>");
  expect(markup).not.toContain(">Clear</button>");
});

it("offers Resume and Clear only where applicable, and displays terminal reasons", () => {
  const paused = render("paused");
  expect(paused).toContain(">Resume</button>");
  expect(paused).toContain(">Clear</button>");
  const blocked = render("blocked");
  expect(blocked).toContain(">Resume</button>");
  expect(blocked).toContain(">Clear</button>");
  expect(blocked).toContain("Needs review");
  const complete = render("complete");
  expect(complete).toContain(">Clear</button>");
  expect(complete).not.toContain(">Resume</button>");
});

it.each(["active", "paused", "blocked", "complete"] as const)(
  "offers only Clear for a Claude %s goal",
  (status) => {
    const markup = render(status, true, "claude");
    expect(markup).toContain(">Clear</button>");
    expect(markup).not.toMatch(/>(Pause|Resume)<\/button>/);
    expect(render(status, false, "claude")).not.toContain("<button");
  },
);

it.each(["active", "paused"] as const)("keeps a read-only %s goal expandable", (status) => {
  const markup = render(status, false);
  expect(markup).toContain("<summary");
  expect(markup).toContain("Ship the fix");
  expect(markup).toContain(status);
  expect(markup).toContain("Needs review");
  expect(markup).not.toContain("<button");
});

function editor({ writable = true, pending = false, objective = "Ship the fix" } = {}) {
  vi.mocked(useState)
    .mockReturnValueOnce(["add", vi.fn()])
    .mockReturnValueOnce([objective, vi.fn()]);
  renderToStaticMarkup(
    <OrbGoal
      goal={null}
      harness="pi"
      writable={writable}
      pending={pending}
      error={null}
      onChange={() => {}}
      onClose={() => {}}
    />,
  );
  return (keys: Partial<KeyboardEvent<HTMLTextAreaElement>> = {}, isComposing = false) => {
    const preventDefault = vi.fn();
    const requestSubmit = vi.fn();
    input.onKeyDown?.({
      key: "Enter",
      nativeEvent: { isComposing },
      currentTarget: { form: { requestSubmit } },
      preventDefault,
      ...keys,
    } as KeyboardEvent<HTMLTextAreaElement>);
    return { preventDefault, requestSubmit };
  };
}

it.each(["metaKey", "ctrlKey"] as const)("requests one form submission with %s+Enter", (key) => {
  const press = editor();
  const first = press({ [key]: true });
  const repeat = press({ [key]: true, repeat: true });
  expect(first.preventDefault).toHaveBeenCalledOnce();
  expect(first.requestSubmit).toHaveBeenCalledOnce();
  expect(repeat.preventDefault).toHaveBeenCalledOnce();
  expect(repeat.requestSubmit).not.toHaveBeenCalled();
});

it("preserves plain Enter and composition", () => {
  const press = editor();
  for (const key of [press(), press({ metaKey: true }, true)]) {
    expect(key.preventDefault).not.toHaveBeenCalled();
    expect(key.requestSubmit).not.toHaveBeenCalled();
  }
});

it.each([{ pending: true }, { writable: false }, { objective: " \n " }])(
  "does not request submission when setting a goal is unavailable (%j)",
  (props) => {
    expect(editor(props)({ metaKey: true }).requestSubmit).not.toHaveBeenCalled();
  },
);

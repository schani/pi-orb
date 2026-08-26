import { describe, expect, it } from "vitest";
import type { AppSearchItem } from "./app-search.ts";
import {
  matchAppSearchItems,
  moveAppSearchSelection,
  normalizeAppSearchText,
  selectedAppSearchIndex,
  shouldCloseAppSearchForActivation,
} from "./app-search.ts";

const item = (key: string, keywords: string[], title = key): AppSearchItem => ({
  key,
  kindLabel: "fixture",
  title,
  keywords,
  href: `#/${key}`,
});

describe("app search core", () => {
  it("normalizes whitespace, case, and Unicode compatibility forms", () => {
    expect(normalizeAppSearchText("  ＰI-Orb  ")).toBe("pi-orb");
  });

  it("matches stable substrings over explicit keywords only", () => {
    const items = [
      item("first", ["Atlas Console"], "title is not implicitly searched"),
      item("second", ["github.com/acme/paper-trail"]),
      item("third", ["atlas worker"]),
    ];

    expect(matchAppSearchItems(items, "atlas").map(({ key }) => key)).toEqual(["first", "third"]);
    expect(matchAppSearchItems(items, "implicitly")).toEqual([]);
    expect(matchAppSearchItems(items, "  PAPER  ").map(({ key }) => key)).toEqual(["second"]);
  });

  it("returns no invented recents for an empty query", () => {
    expect(matchAppSearchItems([item("first", ["anything"])], "  ")).toEqual([]);
  });

  it("moves one shared pointer/keyboard selection without parallel active rows", () => {
    const items = [item("first", ["match"]), item("second", ["match"]), item("third", ["match"])];
    expect(selectedAppSearchIndex(items, "second")).toBe(1);
    expect(moveAppSearchSelection(items, "second", 1)).toBe("third");
    expect(moveAppSearchSelection(items, "second", -1)).toBe("first");
    expect(selectedAppSearchIndex(items, "no-longer-present")).toBe(0);
    expect(moveAppSearchSelection(items, "no-longer-present", 1)).toBe("second");
  });

  it("closes only for unmodified primary activation", () => {
    const primary = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(shouldCloseAppSearchForActivation(primary)).toBe(true);
    expect(shouldCloseAppSearchForActivation({ ...primary, metaKey: true })).toBe(false);
    expect(shouldCloseAppSearchForActivation({ ...primary, ctrlKey: true })).toBe(false);
    expect(shouldCloseAppSearchForActivation({ ...primary, button: 1 })).toBe(false);
  });
});

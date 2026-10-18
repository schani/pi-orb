import type { OrbView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { buildProjectOrbTree } from "./project-orb-tree.ts";
import { splitProjectOrbs } from "./project-orbs.ts";

const orb = (id: string, spawnedByOrb?: string, state: OrbView["state"] = "running"): OrbView => ({
  id,
  projectId: "project",
  harness: "pi",
  name: id,
  state,
  stateVersion: 1,
  stateChangedAt: "2026-10-01T00:00:00Z",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...(spawnedByOrb === undefined ? {} : { spawnedByOrb }),
});
const rows = (items: OrbView[]) =>
  buildProjectOrbTree(items).map(({ orb, depth }) => [orb.id, depth]);

describe("working orb tree", () => {
  it("keeps stable root/sibling order and places every descendant directly after its parent", () => {
    const items = [
      orb("child-b", "parent"),
      orb("other"),
      orb("grandchild", "child-a"),
      orb("parent"),
      orb("child-a", "parent"),
    ];
    expect(rows(splitProjectOrbs(items).working)).toEqual([
      ["other", 0],
      ["parent", 0],
      ["child-b", 1],
      ["child-a", 1],
      ["grandchild", 2],
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "child-b",
      "other",
      "grandchild",
      "parent",
      "child-a",
    ]);
  });

  it.each(["stopped", "failed"] as const)("nests below a %s parent", (state) => {
    expect(rows([orb("child", "parent"), orb("parent", undefined, state)])).toEqual([
      ["parent", 0],
      ["child", 1],
    ]);
  });

  it.each(["archiving", "archived", "deleting", "missing"] as const)(
    "promotes to root when the direct parent is %s, never to a grandparent",
    (state) => {
      const items = [orb("grandparent"), orb("child", "parent"), orb("grandchild", "child")];
      if (state !== "missing") items.push(orb("parent", "grandparent", state));
      const shelves = splitProjectOrbs(items);
      expect(rows(shelves.working)).toEqual([
        ["grandparent", 0],
        ["child", 0],
        ["grandchild", 1],
      ]);
      expect(shelves.archive.map((item) => item.id)).toEqual(state === "missing" ? [] : ["parent"]);
    },
  );

  it("shelves each orb independently and leaves archive order flat", () => {
    const shelves = splitProjectOrbs([
      orb("archived-child", "parent", "archived"),
      orb("parent"),
      orb("child", "archived-child"),
      orb("grandchild", "child"),
      orb("archived-grandchild", "archived-child", "archived"),
    ]);
    expect(rows(shelves.working)).toEqual([
      ["parent", 0],
      ["child", 0],
      ["grandchild", 1],
    ]);
    expect(shelves.archive.map((item) => item.id)).toEqual([
      "archived-child",
      "archived-grandchild",
    ]);
  });

  it("does not attach across projects", () => {
    expect(rows([orb("child", "parent"), { ...orb("parent"), projectId: "other" }])).toEqual([
      ["child", 0],
      ["parent", 0],
    ]);
  });

  it("preserves first-observed ordering across polls, promotion and metadata updates", () => {
    const order = new Map();
    const parent = orb("parent");
    const child = { ...orb("child", "parent"), updatedAt: "2026-10-03T00:00:00Z" };
    const other = { ...orb("other"), updatedAt: "2026-10-02T00:00:00Z" };
    expect(rows(splitProjectOrbs([child, other, parent], order).working)).toEqual([
      ["other", 0],
      ["parent", 0],
      ["child", 1],
    ]);
    const refreshed = { ...other, name: "renamed", updatedAt: "2100-01-01T00:00:00Z" };
    const result = buildProjectOrbTree(splitProjectOrbs([parent, refreshed, child], order).working);
    expect(result.map(({ orb, depth }) => [orb.id, depth])).toEqual([
      ["other", 0],
      ["parent", 0],
      ["child", 1],
    ]);
    expect(result[0]?.orb).toBe(refreshed);
    expect(
      rows(splitProjectOrbs([child, refreshed, { ...parent, state: "archiving" }], order).working),
    ).toEqual([
      ["child", 0],
      ["other", 0],
    ]);
  });

  it("renders malformed cycles once each without hiding their descendants or unrelated roots", () => {
    const items = [
      orb("a", "b"),
      orb("b", "c"),
      orb("c", "a"),
      orb("leaf", "b"),
      orb("self", "self"),
      orb("root"),
    ];
    const result = buildProjectOrbTree(items);
    expect(result.map(({ orb }) => orb.id)).toEqual(["self", "root", "a", "c", "b", "leaf"]);
    expect(new Set(result.map(({ orb }) => orb.id)).size).toBe(items.length);
    expect(result.find(({ orb }) => orb.id === "leaf")?.depth).toBe(3);
  });

  it("keeps deep lineage visible without a recursive call stack or depth limit", () => {
    const items = Array.from({ length: 10_000 }, (_, index) =>
      orb(String(index), index === 0 ? undefined : String(index - 1)),
    );
    const result = buildProjectOrbTree(items.reverse());
    expect(result).toHaveLength(10_000);
    expect(result[0]?.orb.id).toBe("0");
    expect(result.at(-1)).toEqual({ orb: items[0], depth: 9_999 });
  });
});

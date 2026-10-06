import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { collectResources } from "./selection.ts";

function fixture(entries: Record<string, { mode: string; value: string }>) {
  for (const path of Object.keys(entries)) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      const parent = parts.join("/");
      entries[parent] ??= { mode: "040000", value: "" };
      parts.pop();
    }
  }
  return {
    entries: Object.entries(entries).map(([path, e]) => ({ path, mode: e.mode, oid: path })),
    blobs: (oids: string[]) =>
      okAsync(new Map(oids.map((oid) => [oid, Buffer.from(entries[oid]?.value ?? "")]))),
  };
}
describe("repository resource selection", () => {
  it("confirms absence without blob calls, but propagates acquisition failure", async () => {
    const absent = await collectResources([], () => {
      throw new Error("must not fetch absent resources");
    });
    expect(absent.isOk() && absent.value.files.length).toBe(0);
    const result = await collectResources([{ path: "AGENTS.md", mode: "100644", oid: "x" }], () =>
      errAsync(resourceError("authentication", "Credentials unavailable")),
    );
    expect(result.isErr() && result.error.code).toBe("authentication");
  });
  it("uses instruction precedence without merging or ambient Claude discovery", async () => {
    const f = fixture({
      ".pi/AGENTS.md": { mode: "100644", value: "primary" },
      "AGENTS.md": { mode: "100644", value: "root" },
      ".agents/AGENTS.md": { mode: "100644", value: "last" },
      "CLAUDE.md": { mode: "100644", value: "ambient" },
    });
    const result = await collectResources(f.entries, f.blobs);
    expect(result.isOk() && result.value.files.map((file) => file.path)).toEqual([".pi/AGENTS.md"]);
  });
  it("follows repository symlinks and serves assets at alias paths", async () => {
    const f = fixture({
      "AGENTS.md": { mode: "120000", value: "CLAUDE.md" },
      "CLAUDE.md": { mode: "100644", value: "instructions" },
      ".agents/skills/x": { mode: "120000", value: "../../.claude/skills/x" },
      ".claude/skills/x/SKILL.md": { mode: "100644", value: "skill" },
      ".claude/skills/x/image.bin": { mode: "100644", value: "\0asset" },
    });
    const r = await collectResources(f.entries, f.blobs);
    expect(r.isOk()).toBe(true);
    if (r.isOk())
      expect(r.value.files.map((f) => f.path)).toEqual([
        ".agents/skills/x/SKILL.md",
        ".agents/skills/x/image.bin",
        "AGENTS.md",
      ]);
  });
  it("resolves symlink ancestors and intermediate target directories", async () => {
    const f = fixture({
      ".pi": { mode: "120000", value: "config" },
      "config/AGENTS.md": { mode: "120000", value: "../alias/instructions.md" },
      alias: { mode: "120000", value: "real" },
      "real/instructions.md": { mode: "100644", value: "instructions" },
      "config/skills/a/SKILL.md": { mode: "100644", value: "skill" },
    });
    const result = await collectResources(f.entries, f.blobs);
    expect(result.isOk() && result.value.files.map((file) => file.path)).toEqual([
      ".pi/AGENTS.md",
      ".pi/skills/a/SKILL.md",
    ]);
  });
  it("batches independent instruction and 41 selected skill links in one wave", async () => {
    const data: Record<string, { mode: string; value: string }> = {
      "AGENTS.md": { mode: "120000", value: "CLAUDE.md" },
      "CLAUDE.md": { mode: "100644", value: "instructions" },
      ".agents/AGENTS.md": { mode: "100644", value: "unselected" },
      "unrelated/blob": { mode: "100644", value: "unrelated" },
    };
    for (let i = 0; i < 41; i++) {
      data[`.agents/skills/s${i}`] = { mode: "120000", value: `../../catalog/s${i}` };
      data[`catalog/s${i}/SKILL.md`] = { mode: "100644", value: "skill" };
      for (let asset = 0; asset < (i < 33 ? 4 : 3); asset++)
        data[`catalog/s${i}/asset${asset}.bin`] = { mode: "100644", value: "asset" };
    }
    const f = fixture(data);
    const batches: string[][] = [];
    const result = await collectResources(f.entries, (oids) => {
      batches.push(oids);
      return f.blobs(oids);
    });
    expect(result.isOk()).toBe(true);
    expect(batches).toHaveLength(2);
    expect(new Set(batches[0])).toEqual(
      new Set(["AGENTS.md", ...Array.from({ length: 41 }, (_, i) => `.agents/skills/s${i}`)]),
    );
    expect(batches[0]).toHaveLength(42);
    expect(batches[1]).toHaveLength(198);
    expect(new Set(batches[1])).toEqual(
      new Set([
        "CLAUDE.md",
        ...Object.keys(data).filter(
          (path) => path.startsWith("catalog/") && data[path]?.mode === "100644",
        ),
      ]),
    );
    expect((await collectResources(f.entries, f.blobs, { maxPaths: 40 })).isErr()).toBe(true);
  });
  it("empty primary directory does not fall back", async () => {
    const f = fixture({
      ".pi/skills": { mode: "040000", value: "" },
      ".agents/skills/a/SKILL.md": { mode: "100644", value: "fallback" },
    });
    const r = await collectResources(f.entries, f.blobs);
    expect(r.isOk() && r.value.files.length).toBe(0);
  });
  it("rejects escape and cycles rather than treating them as absence", async () => {
    for (const target of ["../outside", "AGENTS.md"]) {
      const f = fixture({ "AGENTS.md": { mode: "120000", value: target } });
      const r = await collectResources(f.entries, f.blobs);
      expect(r.isErr()).toBe(true);
    }
  });
  it("keeps symlink depth bounds local to each resolved path", async () => {
    const data: Record<string, { mode: string; value: string }> = {
      ".pi/skills": { mode: "120000", value: "../root0" },
      "catalog/skill": { mode: "120000", value: "../child0" },
      "real/SKILL.md": { mode: "100644", value: "skill" },
    };
    for (let i = 0; i < 20; i++) {
      data[`root${i}`] = { mode: "120000", value: i === 19 ? "catalog" : `root${i + 1}` };
      data[`child${i}`] = { mode: "120000", value: i === 19 ? "real" : `child${i + 1}` };
    }
    const f = fixture(data);
    const result = await collectResources(f.entries, f.blobs);
    expect(result.isOk() && result.value.files.map((file) => file.path)).toEqual([
      ".pi/skills/skill/SKILL.md",
    ]);
  });
  it("indexes a large catalog without fetching fallback or unrelated blobs", async () => {
    const f = fixture({
      ".pi/skills/a/SKILL.md": { mode: "100644", value: "skill" },
      ".agents/skills": { mode: "120000", value: "../../../escape" },
    });
    for (let i = 0; i < 20_000; i++)
      f.entries.push({ path: `unrelated/${i}/blob`, mode: "100644", oid: `unrelated-${i}` });
    const batches: string[][] = [];
    const result = await collectResources(f.entries, (oids) => {
      batches.push(oids);
      return f.blobs(oids);
    });
    expect(result.isOk()).toBe(true);
    expect(batches).toEqual([[".pi/skills/a/SKILL.md"]]);
    const cycle = fixture({ ".pi/skills/a/back": { mode: "120000", value: ".." } });
    expect((await collectResources(cycle.entries, cycle.blobs)).isErr()).toBe(true);
  });
  it("validates primary root and content bounds", async () => {
    const f = fixture({ ".pi/skills": { mode: "100644", value: "bad" } });
    expect((await collectResources(f.entries, f.blobs)).isErr()).toBe(true);
    const g = fixture({ "AGENTS.md": { mode: "100644", value: "long" } });
    expect((await collectResources(g.entries, g.blobs, { maxBytes: 2 })).isErr()).toBe(true);
    const expanded = fixture({
      ".pi/skills/a": { mode: "120000", value: "../../x" },
      ".pi/skills/b": { mode: "120000", value: "../../x" },
      "x/SKILL.md": { mode: "100644", value: "x".repeat(30) },
    });
    const bounded = await collectResources(expanded.entries, expanded.blobs, { maxBytes: 50 });
    expect(bounded.isErr() && bounded.error.message).toBe("Expanded resource byte limit exceeded");
  });
});

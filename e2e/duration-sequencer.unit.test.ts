import { relative, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createVitest } from "vitest/node";
import { balanceFiles } from "./duration-sequencer.ts";
import { durationWeights } from "./duration-weights.ts";

it("balances whole files longest-first with stable path/shard tie-breaks", () => {
  const weights = { a: 90, b: 60, c: 40, d: 30, e: 20 };
  const files = Object.keys(weights);
  expect(balanceFiles(files, 2, weights)).toEqual([
    { files: ["a", "d"], estimatedMs: 120 },
    { files: ["b", "c", "e"], estimatedMs: 120 },
  ]);
  expect(balanceFiles(files.reverse(), 2, weights)).toEqual(
    balanceFiles([...files].sort(), 2, weights),
  );
});

it("includes new files conservatively without changing the checked-in input", () => {
  const weights = { known: 90, small: 20 };
  expect(balanceFiles(["unknown", "known", "small"], 2, weights)).toEqual([
    { files: ["known", "small"], estimatedMs: 110 },
    { files: ["unknown"], estimatedMs: 90 },
  ]);
  expect(weights).toEqual({ known: 90, small: 20 });
});

it("retains fully-skipped discovered files and empty shards without inventing durations", () => {
  expect(balanceFiles(["b", "a"], 4, { a: 0, b: 0 })).toEqual([
    { files: ["a"], estimatedMs: 0 },
    { files: ["b"], estimatedMs: 0 },
    { files: [], estimatedMs: 0 },
    { files: [], estimatedMs: 0 },
  ]);
});

it("uses positive finite measured weights with explicit provenance for each axis", () => {
  for (const axis of ["frontend", "docker", "process"] as const) {
    expect(durationWeights[axis].source).toMatch(
      /^https:\/\/github.com\/schani\/pi-orb\/actions\/runs\/\d+$/u,
    );
    const weights = durationWeights[axis].files;
    expect(Object.keys(weights).length).toBeGreaterThan(0);
    for (const [path, ms] of Object.entries(weights)) {
      expect(path).toMatch(/^e2e\/.+\.e2e\.test\.ts$/u);
      expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    }
  }
  expect(durationWeights.docker.files["e2e/full-slice.e2e.test.ts"]).not.toBe(
    durationWeights.process.files["e2e/full-slice.e2e.test.ts"],
  );
});

it("actual production shards and order match checked-in axis weights, not poisoned cache", async () => {
  const previous = process.env["PI_ORB_E2E_BACKEND"];
  try {
    for (const backend of ["docker", "process"] as const) {
      process.env["PI_ORB_E2E_BACKEND"] = backend;
      const ctx = await createVitest("test", {
        root,
        config: resolve(root, "e2e/vitest.config.ts"),
        watch: false,
        shard: "1/4",
      });
      try {
        const specs = await ctx.globTestSpecifications();
        const cacheResults = vi
          .spyOn(ctx.cache, "getFileTestResults")
          .mockImplementation((key) => ({
            failed: key.includes("auth"),
            duration: key.length * 100_000,
          }));
        const cacheStats = vi
          .spyOn(ctx.cache, "getFileStats")
          .mockImplementation((key) => ({ size: 100_000 - key.length }));
        for (const project of ["frontend", "lifecycle"]) {
          const discovered = specs.filter((s) => s.project.name === project);
          const axis = project === "frontend" ? "frontend" : backend;
          const weights: Readonly<Record<string, number>> = durationWeights[axis].files;
          const fallback = Math.max(...Object.values(weights));
          const paths = discovered.map((s) => relative(root, s.moduleId));
          const unknown = `e2e/new-${project}.e2e.test.ts`;
          // A discovered specification with a new path exercises the real sequencer's fallback.
          const newSpec = Object.assign(
            Object.create(Object.getPrototypeOf(discovered[0])),
            discovered[0],
            { moduleId: resolve(root, unknown) },
          );
          const inputs = [...discovered, newSpec];
          const duration = (path: string) => weights[path] ?? fallback;
          const longestFirst = [...paths, unknown].sort(
            (a, b) => duration(b) - duration(a) || lexical(a, b),
          );
          const expected = Array.from({ length: 4 }, (_, index) => ({
            index,
            total: 0,
            paths: [] as string[],
          }));
          for (const path of longestFirst) {
            const target = [...expected].sort(
              (a, b) => a.total - b.total || a.paths.length - b.paths.length || a.index - b.index,
            )[0];
            expect(target).toBeDefined();
            if (target === undefined) continue;
            target.paths.push(path);
            target.total += duration(path);
          }
          const sequencer = new ctx.config.sequence.sequencer(ctx);
          for (const [index, shard] of expected.entries()) {
            ctx.config.shard = { index: index + 1, count: 4 };
            const actual = await sequencer.shard([...inputs].reverse());
            expect(actual.map((s) => relative(root, s.moduleId))).toEqual(
              [...shard.paths].sort(lexical),
            );
            const execution = await sequencer.sort([...actual].reverse());
            expect(execution.map((s) => relative(root, s.moduleId))).toEqual(
              longestFirst.filter((path) => shard.paths.includes(path)),
            );
          }
        }
        expect(cacheResults).not.toHaveBeenCalled();
        expect(cacheStats).not.toHaveBeenCalled();
      } finally {
        await ctx.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env["PI_ORB_E2E_BACKEND"];
    else process.env["PI_ORB_E2E_BACKEND"] = previous;
  }
});

const root = resolve(import.meta.dirname, "..");
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

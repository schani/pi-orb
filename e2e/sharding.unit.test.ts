import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createVitest } from "vitest/node";

const root = resolve(import.meta.dirname, "..");
const workflow = (name: string) =>
  readFileSync(resolve(root, `.github/workflows/${name}.yml`), "utf8");

it("uses the same declared Node and OS versions for CI, E2E and Deploy", () => {
  for (const name of ["ci", "e2e", "deploy"]) {
    expect(workflow(name)).toContain("runs-on: ubuntu-24.04");
    expect(workflow(name)).toContain("node-version: '24.6.0'");
  }
});

it("runs four isolated serial E2E shards without cancelling siblings or losing failure evidence", () => {
  const source = workflow("e2e");
  expect(source).toContain(`name: E2E (\${{ matrix.shard }}/4)`);
  expect(source).toContain("fail-fast: false");
  expect(source).toContain("shard: [1, 2, 3, 4]");
  expect(source).toContain(`run: npm run test:e2e -- --shard=\${{ matrix.shard }}/4`);
  expect(source).not.toMatch(/--(?:maxWorkers|project|retry|passWithNoTests)/u);
  expect(
    source.match(/name: e2e-.*matrix\.shard.*github\.run_id.*github\.run_attempt/gu),
  ).toHaveLength(2);
  expect(source.match(/if: failure\(\)/gu)).toHaveLength(2);
  const traceUpload = source
    .split("- name: Upload deterministic failure traces")[1]
    ?.split("- name:")[0];
  expect(traceUpload).toBeDefined();
  const paths = traceUpload?.match(/path: \|\n((?:[ \t]+test-failures\/[^\n]+\n)+)/u)?.[1];
  expect(paths?.trim().split(/\n\s*/u)).toEqual([
    "test-failures/*.json",
    "test-failures/profile-login/failure.json",
    "test-failures/full-slice-upload/failure.json",
    "test-failures/subagent-*/failure.json",
  ]);
  expect(source).toContain("test-failures/lazy-return-*/trace.zip");
});

it("the actual Vitest sequencer partitions every E2E file exactly once across four shards", async () => {
  const ctx = await createVitest("test", {
    root,
    config: resolve(root, "e2e/vitest.config.ts"),
    watch: false,
    shard: "1/4",
  });
  try {
    expect(ctx.config.maxWorkers).toBe(1);
    expect(
      ctx.projects.map((project) => [project.name, project.config.sequence.groupOrder]),
    ).toEqual([
      ["frontend", 1],
      ["lifecycle", 2],
    ]);
    const all = await ctx.globTestSpecifications();
    const key = (spec: (typeof all)[number]) => `${spec.project.name}:${spec.moduleId}`;
    expect(all.length).toBeGreaterThan(4);
    expect(all.map((spec) => spec.moduleId).sort()).toEqual(
      globSync("e2e/**/*.e2e.test.ts", { cwd: root })
        .map((file) => resolve(root, file))
        .sort(),
    );
    for (const project of ctx.projects) {
      const excluded = new Set(globSync(project.config.exclude, { cwd: root }));
      const files = globSync(project.config.include, { cwd: root })
        .filter((file) => !excluded.has(file))
        .map((file) => resolve(root, file));
      expect(files.length).toBeGreaterThan(0);
      expect(
        all
          .filter((spec) => spec.project === project)
          .map((spec) => spec.moduleId)
          .sort(),
      ).toEqual([...new Set(files)].sort());
    }
    const expected = all.map(key).sort();
    const assigned: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      ctx.config.shard = { index, count: 4 };
      const Sequencer = ctx.config.sequence.sequencer;
      const shard = (await new Sequencer(ctx).shard([...all])).map(key).sort();
      expect(shard.length).toBeGreaterThan(0);
      expect(shard.some((file) => assigned.includes(file))).toBe(false);
      assigned.push(...shard);
      console.info(
        `E2E shard ${index}/4: ${shard.map((file) => file.replace(`${root}/`, "")).join(", ")}`,
      );
    }
    expect(assigned.sort()).toEqual(expected);
    expect(new Set(all.map((spec) => spec.moduleId)).size).toBe(all.length);
  } finally {
    await ctx.close();
  }
});

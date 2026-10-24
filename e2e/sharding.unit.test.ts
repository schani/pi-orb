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
    expect(workflow(name)).toContain("node-version: '24.22.1'");
  }
});

it("runs four isolated serial E2E shards without cancelling siblings or losing failure evidence", () => {
  const source = workflow("e2e");
  expect(source).toContain(`name: E2E (\${{ matrix.shard }}/4)`);
  expect(source).toContain("fail-fast: false");
  expect(source).toContain("shard: [1, 2, 3, 4]");
  expect(source).toContain("  pull_request:\n  push:\n    branches:\n      - main\n");
  const normalRun = source.split("- name: Run end-to-end test")[1]?.split("- name:")[0];
  expect(normalRun).toBeDefined();
  expect(source).toContain("  workflow_dispatch:\n");
  expect(source).toContain("timeout-minutes: 40");
  expect(normalRun).toContain(
    `run: node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project frontend --project provider --project postgres --shard=\${{ matrix.shard }}/4`,
  );
  expect(normalRun).not.toMatch(/--(?:maxWorkers|retry|passWithNoTests)/u);
  expect(
    source.match(/name: e2e-.*matrix\.shard.*github\.run_id.*github\.run_attempt[^\n]*/gu),
  ).toEqual([
    `name: e2e-durable-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-dst-failure-traces-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-missing-orb-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-lazy-return-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-browser-failure-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
  ]);
  expect(source.match(/if: failure\(\)/gu)).toHaveLength(7);
  const traceUpload = source
    .split("- name: Upload deterministic failure traces")[1]
    ?.split("- name:")[0];
  expect(traceUpload).toBeDefined();
  const paths = traceUpload?.match(/path: \|\n((?:[ \t]+test-failures\/[^\n]+\n)+)/u)?.[1];
  expect(paths?.trim().split(/\n\s*/u)).toEqual([
    "test-failures/*.json",
    "test-failures/profile-login/failure.json",
    "test-failures/full-slice-upload/failure.json",
  ]);
  expect(source).toContain("test-failures/lazy-return-*/trace.zip");
  const browserUpload = source
    .split("- name: Upload harness browser failure evidence")[1]
    ?.split("- name:")[0];
  expect(browserUpload?.match(/if: (.+)/u)?.[1]).toBe("failure()");
  expect(browserUpload?.match(/path: (.+)/u)?.[1]).toBe(
    ".context/claude-production-hardening/browser-failure",
  );
  expect(browserUpload).toContain("include-hidden-files: true");
});

it("the actual Vitest sequencer partitions every E2E file exactly once across four shards", async () => {
  const ctx = await createVitest({
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
      ["process", 2],
      ["provider", 3],
      ["postgres", 4],
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

it("selects shared and forced-process files once but both genuine provider compositions", async () => {
  const selected = new Map<string, string[]>();
  for (const [backend, projects] of [
    ["docker", ["frontend", "provider", "postgres"]],
    ["process", ["process", "provider"]],
  ] as const) {
    const ctx = await createVitest({
      root,
      config: resolve(root, "e2e/vitest.config.ts"),
      watch: false,
      project: [...projects],
    });
    try {
      const specs = await ctx.globTestSpecifications();
      selected.set(backend, specs.map((spec) => spec.moduleId).sort());
      expect(ctx.projects.map((project) => project.name).sort()).toEqual([...projects].sort());
      const assigned: string[] = [];
      for (const index of [1, 2, 3, 4]) {
        ctx.config.shard = { index, count: 4 };
        const shard = await new ctx.config.sequence.sequencer(ctx).shard([...specs]);
        expect(shard.length).toBeGreaterThan(0);
        assigned.push(...shard.map((spec) => spec.moduleId));
      }
      expect(assigned.sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
    } finally {
      await ctx.close();
    }
  }
  const docker = selected.get("docker")!;
  const process = selected.get("process")!;
  expect(docker.filter((file) => process.includes(file))).toEqual([
    resolve(root, "e2e/cross-axis.e2e.test.ts"),
    resolve(root, "e2e/full-slice.e2e.test.ts"),
  ]);
  expect([...new Set([...docker, ...process])].sort()).toEqual(
    globSync("e2e/**/*.e2e.test.ts", { cwd: root })
      .map((file) => resolve(root, file))
      .sort(),
  );
  expect(docker).toContain(resolve(root, "e2e/postgres-store.e2e.test.ts"));
  for (const file of [
    "mcp-oauth",
    "full-main-auth",
    "multi-user-credentials",
    "orb-alerts",
    "orb-sleep",
    "idle-stop-view",
    "durable-independent-process",
  ]) {
    expect(process).toContain(resolve(root, `e2e/${file}.e2e.test.ts`));
    expect(docker).not.toContain(resolve(root, `e2e/${file}.e2e.test.ts`));
  }
});

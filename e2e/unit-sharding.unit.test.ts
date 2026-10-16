import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createVitest } from "vitest/node";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const jobs = Object.fromEntries(
  [
    ...(source.split("\njobs:\n")[1] ?? "").matchAll(
      /^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|(?![\s\S]))/gmu,
    ),
  ].map(([, name, body]) => [name, body]),
);

it("runs four isolated serial unit/DST shards with both real-PG contracts and first-failure traces", () => {
  const unit = jobs.unit;
  expect(unit).toBeDefined();
  expect(unit).toContain(`name: Unit/DST (\${{ matrix.shard }}/4)`);
  expect(unit).toContain("runs-on: ubuntu-24.04");
  expect(unit).toContain("fail-fast: false");
  expect(unit).toContain("shard: [1, 2, 3, 4]");
  expect(unit).not.toMatch(/^ {4}(?:needs|if):/mu);
  expect(unit).toContain("image: postgres:16");
  expect(unit).toContain("5432:5432");
  expect(unit).toContain('--health-cmd "pg_isready -U qualification -d qualification"');
  expect(unit?.match(/^ {6}PI_ORB_\w+: .+$/gmu)).toEqual([
    "      PI_ORB_TEST_DATABASE_URL: postgres://qualification:qualification@127.0.0.1:5432/qualification",
    "      PI_ORB_DURABLE_PG_TEST_URL: postgres://qualification:qualification@127.0.0.1:5432/qualification",
  ]);
  expect(unit).toContain("node-version: '24.6.0'");
  expect(unit).toContain("run: npm ci");
  expect(unit?.indexOf("run: npm ci")).toBeLessThan(unit?.indexOf("run: npx vitest") ?? 0);
  expect(unit?.match(/^ {8}run: npx vitest .+$/gmu)).toEqual([
    `        run: npx vitest run --maxWorkers=1 --no-file-parallelism --shard=\${{ matrix.shard }}/4`,
  ]);
  expect(unit).not.toMatch(
    /continue-on-error:|retry|passWithNoTests|DST_\w+:|\w+_SEEDS:|\w+_FIRST_SEED:/u,
  );
  const upload = unit?.split("- name: Upload deterministic failure traces")[1];
  expect(upload).toContain("if: failure()");
  expect(upload).toContain(
    `name: ci-dst-failure-traces-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
  );
  expect(upload?.match(/path: (.+)/u)?.[1]).toBe("test-failures/*.json");
  expect(upload).toContain("if-no-files-found: ignore");
  expect(upload).toContain("retention-days: 14");
});

it("runs non-unit gates once outside the shard matrix", () => {
  const checks = jobs.checks;
  expect(checks).toBeDefined();
  expect(checks).not.toMatch(/strategy:|services:|PI_ORB_.*_URL:|vitest run/u);
  for (const command of [
    "infra/foundation/test.sh",
    "npm run typecheck",
    "npm run lint",
    "npm run test:infra",
  ]) {
    expect(checks).toContain(`run: ${command}`);
    expect(source.split(`run: ${command}`)).toHaveLength(2);
    expect(jobs.unit).not.toContain(command);
  }
});

it("the actual unit sequencer assigns every file exactly once without changing seeds or contracts", async () => {
  const ctx = await createVitest("test", {
    root,
    config: resolve(root, "vitest.config.ts"),
    watch: false,
    maxWorkers: 1,
    fileParallelism: false,
    shard: "1/4",
  });
  try {
    expect(ctx.config.maxWorkers).toBe(1);
    expect(ctx.config).toHaveProperty("fileParallelism", false);
    const all = await ctx.globTestSpecifications();
    const files = all.map((spec) => spec.moduleId).sort();
    expect(files).toEqual(
      globSync(
        ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}", "e2e/**/*.unit.test.ts"],
        { cwd: root },
      )
        .map((file) => resolve(root, file))
        .sort(),
    );
    expect(new Set(files).size).toBe(files.length);
    expect(files.some((file) => file.endsWith(".dst.test.ts"))).toBe(true);
    for (const contract of [
      "apps/control-plane/src/adapters/pg/stores.postgres.test.ts",
      "apps/control-plane/src/adapters/durable-pg/conformance.test.ts",
    ]) {
      expect(files).toContain(resolve(root, contract));
    }
    const assigned: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      ctx.config.shard = { index, count: 4 };
      const Sequencer = ctx.config.sequence.sequencer;
      const shard = (await new Sequencer(ctx).shard([...all])).map((spec) => spec.moduleId);
      expect(shard.length).toBeGreaterThan(0);
      expect(shard.some((file) => assigned.includes(file))).toBe(false);
      assigned.push(...shard);
      console.info(`Unit/DST shard ${index}/4: ${shard.length} files`);
    }
    expect(assigned.sort()).toEqual(files);
  } finally {
    await ctx.close();
  }
});

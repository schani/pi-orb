import { globSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { initSync, parse } from "es-module-lexer";
import { expect, it } from "vitest";
import { createVitest } from "vitest/node";

const root = resolve(import.meta.dirname, "..");
const workflow = (name: string) =>
  readFileSync(resolve(root, `.github/workflows/${name}.yml`), "utf8");
const job = (source: string, name: string) =>
  source.split(`\n  ${name}:\n`)[1]?.split(/^ {2}[\w-]+:\n/mu)[0] ?? "";

it("uses the same declared Node and OS versions for CI, E2E and Deploy", () => {
  for (const name of ["ci", "e2e", "deploy"]) {
    expect(workflow(name)).toContain("runs-on: ubuntu-24.04");
    expect(workflow(name)).toContain("node-version: '24.22.0'");
  }
});

it("requires one shared frontend gate and both isolated lifecycle axes", () => {
  const source = workflow("e2e");
  const frontend = job(source, "frontend");
  expect(frontend).toContain(`name: Frontend (\${{ matrix.shard }}/4)`);
  expect(frontend).toContain(
    "if: github.event_name != 'workflow_dispatch' || !inputs.subagent_continuation_diagnostic",
  );
  expect(frontend).toContain(
    `npm run test:e2e -- --project frontend --shard=\${{ matrix.shard }}/4`,
  );
  expect(frontend).not.toMatch(/local-fake-provider|PI_ORB_(?:E2E|AGENT)_BACKEND|[Dd]ocker/u);
  expect(frontend).toContain("npm run test:e2e:install");
  expect(frontend).toContain("if: failure()");
  expect(frontend).not.toMatch(/path: test-failures\/\s*$/mu);
  for (const name of [
    "Upload missing-orb navigation failure evidence",
    "Upload lazy-return browser failure evidence",
  ]) {
    expect(frontend).toContain(`- name: ${name}`);
    expect(job(source, "e2e")).not.toContain(`- name: ${name}`);
  }
  for (const path of [
    "missing-orb-*/failure.json",
    "missing-orb-*/desktop.png",
    "missing-orb-*/geometry.json",
    "lazy-return-*/failure.json",
    "lazy-return-*/failure.png",
    "lazy-return-*/trace.zip",
  ]) {
    expect(frontend).toContain(`test-failures/${path}`);
  }
  for (const [body, name, backend] of [
    [job(source, "e2e"), "E2E", "docker"],
    [job(workflow("durable-qualification"), "process"), "Central process", "process"],
  ]) {
    expect(body).toContain(`name: ${name} (\${{ matrix.shard }}/4)`);
    expect(body).toContain(`PI_ORB_E2E_BACKEND: ${backend}`);
    expect(body).toContain(
      `node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project lifecycle --shard=\${{ matrix.shard }}/4`,
    );
    expect(body).not.toContain("--project frontend");
    expect(body).toContain("test-failures/");
  }
  for (const body of [
    frontend,
    job(source, "e2e"),
    job(workflow("durable-qualification"), "process"),
  ]) {
    expect(body).toContain("fail-fast: false");
    expect(body).toContain("shard: [1, 2, 3, 4]");
    expect(body).not.toMatch(/--(?:maxWorkers|retry|passWithNoTests|testTimeout)/u);
  }
});

it("preserves non-qualification diagnostic dispatch and shard-specific evidence", () => {
  const source = workflow("e2e");
  const lifecycle = job(source, "e2e");
  expect(lifecycle).toContain(
    `name: E2E (\${{ matrix.shard }}/4)\${{ github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic && ' diagnostic' || '' }}`,
  );
  const normal = lifecycle.split("- name: Run end-to-end test")[1]?.split("- name:")[0];
  expect(normal).toContain(
    "if: github.event_name != 'workflow_dispatch' || !inputs.subagent_continuation_diagnostic",
  );
  const diagnostic = lifecycle
    .split("- name: Diagnose subagent continuation")[1]
    ?.split("- name:")[0];
  expect(diagnostic).toContain(
    "if: github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic",
  );
  expect(diagnostic?.match(/if: (.+)/u)?.[1]).toBe(
    "github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic",
  );
  expect(diagnostic?.match(/run: (.+)/u)?.[1]).toBe(
    "npm run test:e2e -- --project lifecycle e2e/subagents.e2e.test.ts",
  );
  expect(diagnostic?.match(/npm run test:e2e/gu)).toHaveLength(1);
  expect(diagnostic).not.toMatch(/for |--(?:retry|passWithNoTests|testTimeout)/u);
  expect(source).toContain("timeout-minutes: 40");
  expect(normal).toContain(
    `run: node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project lifecycle --shard=\${{ matrix.shard }}/4`,
  );
  expect(normal).not.toMatch(/--(?:maxWorkers|retry|passWithNoTests)/u);
  expect(lifecycle.match(/^ {4}name: (.+)$/mu)?.[1]).toBe(
    `E2E (\${{ matrix.shard }}/4)\${{ github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic && ' diagnostic' || '' }}`,
  );
  expect(
    source.match(/name: e2e-.*matrix\.shard.*github\.run_id.*github\.run_attempt[^\n]*/gu),
  ).toEqual([
    `name: e2e-durable-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-dst-failure-traces-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-missing-orb-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-lazy-return-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `name: e2e-browser-failure-\${{ matrix.shard }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
  ]);
  expect(lifecycle.match(/if: failure\(\)/gu)).toHaveLength(3);
  expect(job(source, "frontend").match(/if: failure\(\)/gu)).toHaveLength(5);
  const traceUpload = lifecycle
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
  const browserUpload = job(source, "frontend")
    .split("- name: Upload harness browser failure evidence")[1]
    ?.split("- name:")[0];
  expect(browserUpload?.match(/if: (.+)/u)?.[1]).toBe("failure()");
  expect(browserUpload?.match(/path: (.+)/u)?.[1]).toBe(
    ".context/claude-production-hardening/browser-failure",
  );
  expect(browserUpload).toContain("include-hidden-files: true");
  expect(diagnostic).not.toMatch(/local-fake-provider|--(?:retry|passWithNoTests)/u);
  expect(source).toContain("test-failures/*.json");
  expect(source).toContain("test-failures/profile-login/failure.json");
  expect(source).toContain("test-failures/full-slice-upload/failure.json");
  expect(source).toContain("test-failures/subagent-*/failure.json");
  expect(source).toContain("test-failures/lazy-return-*/trace.zip");
  for (const body of [
    job(source, "frontend"),
    lifecycle,
    job(workflow("durable-qualification"), "process"),
  ]) {
    const artifacts = [...body.matchAll(/name: ([^\n]*\$\{\{ github.run_id \}\}[^\n]*)/gu)].map(
      (m) => m[1],
    );
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact).toContain(`\${{ matrix.shard }}`);
      expect(artifact).toContain(`\${{ github.run_attempt }}`);
    }
  }
});

it("actual discovery is complete/disjoint per project and backend, serial and cache-independent", async () => {
  const previous = process.env["PI_ORB_E2E_BACKEND"];
  try {
    for (const backend of ["docker", "process"]) {
      process.env["PI_ORB_E2E_BACKEND"] = backend;
      const ctx = await createVitest({
        root,
        config: resolve(root, "e2e/vitest.config.ts"),
        watch: false,
        shard: "1/4",
      });
      try {
        expect(ctx.config.maxWorkers).toBe(1);
        expect(ctx.config).toMatchObject({ fileParallelism: false });
        expect(ctx.config.sequence.sequencer.name).toBe("DurationBalancedSequencer");
        expect(
          ctx.projects.map((p) => [
            p.name,
            p.config.pool,
            p.config.maxWorkers,
            p.config.sequence.groupOrder,
          ]),
        ).toEqual([
          ["frontend", "threads", 1, 1],
          ["lifecycle", "forks", 1, 2],
        ]);
        const all = await ctx.globTestSpecifications();
        expect(all.map((s) => s.moduleId).sort()).toEqual(
          globSync("e2e/**/*.e2e.test.ts", { cwd: root })
            .map((f) => resolve(root, f))
            .sort(),
        );
        expect(new Set(all.map((s) => s.moduleId)).size).toBe(all.length);
        const frontend = ctx.projects.find((p) => p.name === "frontend");
        expect(frontend?.config.globalSetup).toEqual([]);
        for (const project of ctx.projects) {
          const excluded = new Set(globSync(project.config.exclude, { cwd: root }));
          const discovered = all.filter((s) => s.project === project);
          expect(discovered.map((s) => s.moduleId).sort()).toEqual(
            [
              ...new Set(
                globSync(project.config.include, { cwd: root })
                  .filter((f) => !excluded.has(f))
                  .map((f) => resolve(root, f)),
              ),
            ].sort(),
          );
          const assigned: string[] = [];
          const Sequencer = ctx.config.sequence.sequencer;
          const sequencer = new Sequencer(ctx);
          for (const index of [1, 2, 3, 4]) {
            ctx.config.shard = { index, count: 4 };
            const shard = await sequencer.shard([...discovered]);
            const ids = shard.map((s) => s.moduleId);
            expect(ids.length).toBeGreaterThan(0);
            expect(ids.some((id) => assigned.includes(id))).toBe(false);
            expect(
              (await sequencer.shard([...discovered].reverse())).map((s) => s.moduleId),
            ).toEqual(ids);
            expect((await sequencer.sort([...shard].reverse())).map((s) => s.moduleId)).toEqual(
              (await sequencer.sort([...shard])).map((s) => s.moduleId),
            );
            assigned.push(...ids);
            console.info(
              `${backend}/${project.name} ${index}/4: ${ids.map((id) => id.replace(`${root}/`, "")).join(", ")}`,
            );
          }
          expect(assigned.sort()).toEqual(discovered.map((s) => s.moduleId).sort());
        }
        for (const file of [
          "full-slice",
          "activity-headlines-lifecycle",
          "subagents",
          "postgres-store",
          "full-main-auth",
        ]) {
          expect(all.find((s) => s.moduleId.endsWith(`/${file}.e2e.test.ts`))?.project.name).toBe(
            "lifecycle",
          );
        }
        for (const spec of all.filter((s) => s.project.name === "frontend"))
          auditFrontend(spec.moduleId);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env["PI_ORB_E2E_BACKEND"];
    else process.env["PI_ORB_E2E_BACKEND"] = previous;
  }
});

function auditFrontend(file: string, visited = new Set<string>()) {
  if (visited.has(file)) return;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  expect(source, file).not.toMatch(
    /PI_ORB_(?:E2E_BACKEND|AGENT_BACKEND|TEST_DATABASE_URL|DURABLE_PG_TEST_URL)|(?:from|import\()\s*["'][^"']*\/(?:harness|agent-backend|global-setup|testkit\/postgres)\.ts/u,
  );
  if (
    file.startsWith(`${root}/e2e/`) &&
    file.endsWith(".e2e.test.ts") &&
    ![
      "application-auth",
      "hosting-security",
      "frontend-web-shell",
      "frontend-route-teardown",
      "frontend-listen",
    ].some((name) => file.endsWith(`/${name}.e2e.test.ts`))
  ) {
    expect(source, file).toContain('mode: "frontend"');
  }
  initSync();
  const [imports] = parse(stripTypeScriptTypes(source));
  for (const entry of imports) {
    const specifier = entry.n;
    if (specifier === undefined) continue;
    expect(specifier, file).not.toMatch(
      /^(?:pg|@electric-sql\/pglite)$|\/adapters\/(?:pg|durable-pg|docker|process)\//u,
    );
    if (!specifier.startsWith(".")) continue;
    const dependency = resolve(dirname(file), specifier);
    if (dependency.endsWith(".ts")) auditFrontend(dependency, visited);
  }
}

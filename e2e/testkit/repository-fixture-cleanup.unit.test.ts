import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("can be imported by global setup without registering test hooks", () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./e2e/testkit/repository-fixture.ts")'],
    { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 20_000 },
  );
  expect(run.status, run.stderr).toBe(0);
});

it.each(
  ["forks", "threads"].flatMap((pool) =>
    ["success", "rejection", "timeout"].map((teardown) => ({ pool, teardown })),
  ),
)(
  "releases the repository fixture before the $pool worker exits after caller teardown $teardown",
  async ({ pool, teardown }) => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-repository-cleanup-test-"));
    const report = join(root, "report.json");
    const caller = join(root, "caller.test.ts");
    const config = join(root, "vitest.config.mjs");
    const failure =
      teardown === "rejection" ? "intentional caller afterAll rejection" : "Hook timed out in 25ms";
    writeFileSync(
      caller,
      [
        `import { afterAll } from ${JSON.stringify(import.meta.resolve("vitest"))};`,
        `import ${JSON.stringify(join(import.meta.dirname, "repository-fixture.unit.test.ts"))};`,
        teardown === "rejection"
          ? `afterAll(async () => { throw new Error(${JSON.stringify(failure)}); });`
          : teardown === "timeout"
            ? "afterAll(() => new Promise(() => {}), 25);"
            : "",
      ].join("\n"),
    );
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        test: {
          include: [caller],
          setupFiles: [join(import.meta.dirname, "repository-fixture-setup.ts")],
        },
      })};`,
    );
    const run = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
        "--pool",
        pool,
        "--reporter=json",
        "--outputFile",
        report,
      ],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, TMPDIR: root },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    let output = "";
    run.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    run.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      const [status] = await once(run, "close");
      expect(status, output).toBe(teardown === "success" ? 0 : 1);
      const result = JSON.parse(readFileSync(report, "utf8"));
      expect(result.success).toBe(teardown === "success");
      if (teardown !== "success") {
        expect(result.testResults[0].status).toBe("failed");
        expect(result.testResults[0].message).toContain(failure);
      }
      expect(result.testResults[0].assertionResults[0].status).toBe("passed");
      const fixture = result.testResults[0].assertionResults[0].meta.repositoryFixture;
      expect(fixture.hostUrl).toMatch(/^git:\/\/127\.0\.0\.1:\d+\/pi-orb$/);
      const probe = spawnSync("git", ["ls-remote", fixture.hostUrl], { timeout: 3_000 });
      expect.soft(probe.error).toBeUndefined();
      expect.soft(probe.status, `fixture still serves ${fixture.hostUrl} from ${root}`).not.toBe(0);
      expect
        .soft(readdirSync(root).filter((name) => name.startsWith("pi-orb-repository-fixture-")))
        .toEqual([]);
    } finally {
      // This runner owns the group, including any daemon left by a failing regression.
      if (run.pid) {
        try {
          process.kill(-run.pid, "SIGTERM");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

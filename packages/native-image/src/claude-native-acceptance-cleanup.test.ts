import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { stageClaudeNativeFixture } from "./testkit/claude-native-fixture.ts";

const execute = promisify(execFile);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "cleans UID2000 private trees for a foreign nonroot caller without masking workload failures",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-foreign-cleanup-"));
    await chmod(directory, 0o755);
    const checkout = await mkdtemp("/tmp/claude-foreign-source-");
    await chmod(checkout, 0o700);
    const repository = new URL("../../../", import.meta.url).pathname;
    for (const path of ["infra", "node_modules", "package.json"])
      await symlink(join(repository, path), join(checkout, path));
    const fixture = stageClaudeNativeFixture(checkout, false);
    try {
      expect(fixture.isOk(), fixture.isErr() ? JSON.stringify(fixture.error) : "").toBe(true);
      if (fixture.isErr()) return;
      const command = [
        "python3",
        "packages/native-image/src/claude-native-acceptance-cleanup.fixture.py",
        join(fixture.value.helpers, "claude-acceptance.sh"),
        directory,
        fixture.value.root,
        checkout,
      ];
      const result = await execute(
        process.getuid?.() === 0 ? "python3" : "sudo",
        process.getuid?.() === 0 ? command.slice(1) : ["-n", "--", ...command],
        { env: { PATH: process.env["PATH"] }, timeout: 90_000 },
      );
      expect(result.stderr).toBe("");
      const scenarios = JSON.parse(result.stdout) as {
        workloadStatus: number;
        cleanupStatus: number;
        exit: number;
        stderr: string;
        leftovers: number;
        sentinel: string;
        operations: string[];
        callerUid: number;
        sourceReadable: boolean;
        retainedTrace: {
          kind: string;
          evidence: { health: { code: string }; nativeRows: { uuid: string }[] };
        } | null;
        stdout: string;
      }[];
      expect(scenarios).toHaveLength(5);
      for (const scenario of scenarios) {
        expect(scenario.callerUid).not.toBe(0);
        expect(scenario.callerUid).not.toBe(2000);
        expect(scenario.sourceReadable).toBe(false);
        expect(scenario.sentinel).toBe("untouched");
        expect(scenario.operations).toEqual(
          scenario.workloadStatus
            ? ["chown", "timeout", "test", "cat", "cat", "cat", "rm"]
            : ["chown", "timeout", "rm"],
        );
        expect(scenario.exit).toBe(scenario.workloadStatus || (scenario.cleanupStatus ? 1 : 0));
        expect(scenario.leftovers).toBe(scenario.cleanupStatus ? 1 : 0);
        if (scenario.cleanupStatus)
          expect(scenario.stderr).toContain("CLAUDE_ACCEPTANCE_CLEANUP_FAILED");
        if (scenario.workloadStatus)
          expect(scenario.stderr).toContain('"phase":"fixture-owned-failure","modelRequests":0');
        if (scenario.workloadStatus) {
          expect(scenario.retainedTrace).toMatchObject({
            kind: "claude_qualification_failure_trace",
            evidence: { health: { code: "claude_stream_identity_gap" } },
          });
          expect(scenario.retainedTrace?.evidence.nativeRows[0]?.uuid).toBe(
            "00000000-0000-4000-8000-000000000029",
          );
          expect(scenario.stdout).not.toContain("PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT");
        } else if (!scenario.cleanupStatus) expect(scenario.stderr).toBe("");
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      if (fixture.isOk()) expect(fixture.value.dispose().isOk()).toBe(true);
      await rm(checkout, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  95_000,
);

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { stageClaudeNativeFixture } from "./testkit/claude-native-fixture.ts";

const execute = promisify(execFile);
const root = new URL("../../../", import.meta.url).pathname;

it("waits for exact complete native receipts under controlled write ordering", async () => {
  const result = await execute(
    process.execPath,
    ["--test", "scripts/claude-production-qualification/receipt-edge.test.mjs"],
    {
      env: { PATH: process.env["PATH"] },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("pass 3");
});

it("installs the acceptance helpers outside first-party source removed by sealing", async () => {
  const install = await readFile("infra/native-vm/install.sh", "utf8");
  const seal = await readFile("infra/native-vm/seal.sh", "utf8");
  const acceptance = await readFile("infra/native-vm/acceptance.sh", "utf8");
  expect(seal).toContain("rm -rf /app/infra");
  expect(install).toContain("mkdir -p /opt/pi-orb/claude-qualification");
  for (const file of [
    "claude-acceptance.sh",
    "claude-worker.mjs",
    "claude-workload.mjs",
    "claude-receipt-edge.mjs",
  ])
    expect(install).toContain(`infra/native-vm/${file}`);
  expect(acceptance).toContain(
    "bash /opt/pi-orb/claude-qualification/claude-acceptance.sh /app /workspace",
  );
});

it("includes genuine Claude runtime acceptance after the existing Pi guest acceptance", async () => {
  const acceptance = await readFile("infra/native-vm/acceptance.sh", "utf8");
  expect(acceptance).toContain("claude-acceptance.sh");
  expect(acceptance.indexOf("claude-acceptance.sh")).toBeGreaterThan(
    acceptance.indexOf("native_guest_acceptance_passed"),
  );
});

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "cleans owned retained files and native descendants after an in-flight workload failure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-acceptance-cleanup-"));
    await chmod(directory, 0o755);
    const fixture = stageClaudeNativeFixture(root);
    try {
      expect(fixture.isOk(), fixture.isErr() ? JSON.stringify(fixture.error) : "").toBe(true);
      if (fixture.isErr()) return;
      const failure = await execute(
        "bash",
        [
          join(fixture.value.helpers, "claude-acceptance.sh"),
          fixture.value.root,
          directory,
          "fail-in-flight",
        ],
        { cwd: fixture.value.root, env: { PATH: process.env["PATH"] }, timeout: 120_000 },
      ).then(
        () => null,
        (error) => error as { code: number; stdout: string; stderr: string },
      );
      expect(failure?.code).toBe(1);
      const retained = JSON.parse(failure?.stdout ?? "null") as {
        kind: string;
        phase: string;
        traceUnavailable?: boolean;
        evidence: Record<string, { nativeRows: unknown[]; streamRows: unknown[] }>;
      };
      expect(
        retained.traceUnavailable,
        "native fixture bootstrap did not retain evidence",
      ).not.toBe(true);
      expect(retained.kind).toBe("claude_qualification_failure_trace");
      expect(retained.phase, "native fixture stopped before receipt observation").toBe(
        "known-receipt-observation",
      );
      expect(retained.evidence["1"]?.nativeRows.length).toBeGreaterThan(0);
      expect(retained.evidence["1"]?.streamRows.length).toBeGreaterThan(0);
      expect(failure?.stdout).not.toContain("synthetic-subscription-not-a-credential");
      expect(failure?.stdout).not.toContain("native-mcp-sentinel");
      expect(failure?.stderr).toContain("code=forced_fixture_failure");
      const progress = JSON.parse(failure?.stderr.trim().split("\n").at(-1) ?? "null") as {
        phase: string;
        elapsedMs: number;
        modelRequests: number;
        phases: { phase: string }[];
      };
      expect(progress.phase).toBe("known-receipt-observation");
      expect(progress.elapsedMs).toBeLessThan(110_000);
      expect(progress.modelRequests).toBe(4);
      expect(progress.phases.map((item) => item.phase)).toContain("known-receipt-durable");
      expect(await readdir(directory)).toEqual([]);
      const wrapper = await readFile("infra/native-vm/claude-acceptance.sh", "utf8");
      expect(wrapper).toContain("--pid --fork --kill-child");
      expect(wrapper).toContain("env -i");
      expect(wrapper).toContain("--bounding-set=-all --no-new-privs");
    } finally {
      if (fixture.isOk()) expect(fixture.value.dispose().isOk()).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  125_000,
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "boots the real Claude adapter and retains native receipts across a killed runtime without replay",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-sealed-acceptance-"));
    await chmod(directory, 0o755);
    const checkout = join(directory, "private-checkout");
    await mkdir(checkout, { mode: 0o700 });
    for (const path of ["apps", "infra", "node_modules", "package.json"])
      await symlink(join(root, path), join(checkout, path));
    const fixture = stageClaudeNativeFixture(checkout);
    let result: { stdout: string; stderr: string };
    try {
      expect(fixture.isOk(), fixture.isErr() ? JSON.stringify(fixture.error) : "").toBe(true);
      if (fixture.isErr()) return;
      expect(await readdir(fixture.value.root)).not.toContain("infra");
      result = await execute(
        "bash",
        [join(fixture.value.helpers, "claude-acceptance.sh"), fixture.value.root],
        {
          cwd: fixture.value.root,
          env: { PATH: process.env["PATH"] },
          timeout: 120_000,
          maxBuffer: 512 * 1024,
        },
      );
    } finally {
      if (fixture.isOk()) expect(fixture.value.dispose().isOk()).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
    expect(result.stderr).toBe("");
    const { timing, ...report } = JSON.parse(result.stdout) as {
      timing: {
        startedAt: string;
        elapsedMs: number;
        phases: { phase: string; elapsedMs: number; modelRequests: number }[];
        nativeEdges: { incarnation: string; event: string; elapsedMs: number }[];
      };
    };
    expect(Number.isNaN(Date.parse(timing.startedAt))).toBe(false);
    expect(timing.elapsedMs).toBeLessThan(110_000);
    const phases = timing.phases.map((item) => item.phase);
    for (const phase of ["graceful-stopped", "known-receipt-durable", "known-receipt-killed"])
      expect(phases).toContain(phase);
    const durable = timing.phases.find((item) => item.phase === "known-receipt-durable");
    const killed = timing.phases.find((item) => item.phase === "known-receipt-killed");
    expect(killed?.elapsedMs).toBeGreaterThanOrEqual(durable?.elapsedMs ?? Infinity);
    expect(killed?.modelRequests).toBe(4);
    for (let index = 1; index < timing.phases.length; index++)
      expect(timing.phases[index]?.elapsedMs).toBeGreaterThanOrEqual(
        timing.phases[index - 1]?.elapsedMs ?? Infinity,
      );
    expect(timing.nativeEdges.filter((edge) => edge.event === "native-spawn")).toHaveLength(6);
    for (const event of ["native-shutdown-request", "native-stdout-eof", "sdk-iterator-eof"])
      expect(timing.nativeEdges.filter((edge) => edge.event === event)).toHaveLength(5);
    expect(report).toEqual({
      schemaVersion: 1,
      syntheticOnly: true,
      billingQualified: false,
      organizationPolicyQualified: false,
      checks: {
        networkNamespace: true,
        externalNetworkDenied: true,
        subscriptionSource: true,
        nativeBoot: true,
        nativeBash: true,
        nativeMcp: true,
        hooks: true,
        inputReceipt: true,
        pullHistory: true,
        supervisedDrain: true,
        retainedSession: true,
        manualContinuation: true,
        noAutomaticReplay: true,
        noDuplicateReceipt: true,
      },
    });
  },
  125_000,
);

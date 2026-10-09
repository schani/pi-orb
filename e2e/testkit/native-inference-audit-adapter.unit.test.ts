import { execFileSync } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error Direct Node preload intentionally has no TS build step.
import { startAudit } from "./native-inference-audit.mjs";
import { startNativeInferenceAudit } from "./native-inference-audit.ts";
import { captureSubagentFailure } from "./subagent-failure-evidence.ts";

const orb = "12345678-1234-4234-8234-123456789abc";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "audit-adapter-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const audit = startNativeInferenceAudit(
    root,
    "https://fake-openai.flingit.run/inference",
  )._unsafeUnwrap();
  const env: Record<string, string> = {
    ...audit.extraEnv,
    PI_ORB_ID: orb,
    UV_THREADPOOL_SIZE: "8",
  };
  return { root, audit, env };
}
it("reports missing, invalid, oversized and unavailable evidence explicitly", () => {
  const { audit } = fixture();
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_missing");
  const file = join(audit.directory, `${orb}-123.json`);
  writeFileSync(file, "{}", { mode: 0o600 });
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_invalid");
  writeFileSync(file, "X".repeat(65537));
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_invalid");
  rmSync(audit.directory, { recursive: true });
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_unavailable");
});
it("owns restart files, preserves Node options, pool configuration and captures success plus local-first failure", async () => {
  const { root, audit, env } = fixture();
  for (const pid of [123, 124]) {
    const started = startAudit({
      env,
      argv: [process.execPath, env.PI_ORB_TEST_AUDIT_ENTRY],
      pid,
    })._unsafeUnwrap();
    channel("undici:request:create").publish({
      request: { origin: env.PI_ORB_TEST_AUDIT_ORIGIN, path: env.PI_ORB_TEST_AUDIT_PATH },
    });
    started.stop();
  }
  const processes = audit.read(orb)._unsafeUnwrap();
  expect(processes).toHaveLength(2);
  expect(processes.map((p) => p.pid)).toEqual([123, 124]);
  expect(processes[0]?.startup).toMatchObject({ configuredThreadpoolSize: 8 });
  expect(audit.extraEnv.NODE_OPTIONS).toContain(process.env.NODE_OPTIONS ?? "");
  audit.bracket("continuation", 1);
  const artifact = join(root, "success.json");
  expect((await audit.save(orb, artifact, "continuation")).isOk()).toBe(true);
  expect(JSON.parse(readFileSync(artifact, "utf8")).brackets[0]).toMatchObject({
    phase: "continuation",
    caseIndex: 1,
  });
  const failure = join(root, "failure.json");
  let observed = false;
  expect(
    (
      await captureSubagentFailure({
        root,
        orb,
        phase: "continuation",
        artifact: failure,
        nativeAudit: audit,
        logs: [],
        probes: {
          health: async () => {
            const local = JSON.parse(readFileSync(failure, "utf8"));
            expect(local.nativeAudit.processes).toHaveLength(2);
            observed = true;
            return { unavailable: true };
          },
        },
      })
    ).isOk(),
  ).toBe(true);
  expect(observed).toBe(true);
  const saved = JSON.stringify(JSON.parse(readFileSync(failure, "utf8")));
  expect(saved).not.toMatch(/flingit|inference\/codex|NODE_OPTIONS/);
});
it("rejects public directory and contains startup/write failure", () => {
  const { audit, env } = fixture();
  chmodSync(audit.directory, 0o755);
  expect(
    startAudit({ env, argv: [process.execPath, env.PI_ORB_TEST_AUDIT_ENTRY], pid: 123 }).isErr(),
  ).toBe(true);
  chmodSync(audit.directory, 0o700);
  rmSync(audit.directory, { recursive: true });
  expect(() =>
    startAudit({ env, argv: [process.execPath, env.PI_ORB_TEST_AUDIT_ENTRY], pid: 123 }),
  ).not.toThrow();
});

it("supports the bundled native fetch channels and excludes actual CP/tool preload imports", () => {
  const { audit, env } = fixture();
  const sourceCheck = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const s = process.binding("natives")["internal/deps/undici/undici"];
    const names = ["request:create","client:beforeConnect","client:connected","client:connectError","client:sendHeaders","request:headers","request:error","request:bodySent","request:trailers"];
    console.log(names.every(n => s.includes("undici:" + n)));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(sourceCheck.trim()).toBe("true");
  execFileSync(
    process.execPath,
    [
      "-e",
      "require('node:diagnostics_channel').channel('undici:request:create').publish({request:{origin:process.env.PI_ORB_TEST_AUDIT_ORIGIN,path:process.env.PI_ORB_TEST_AUDIT_PATH}})",
    ],
    { env: { ...process.env, ...env } },
  );
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_missing");
});
it("contains callback write failure, preserves configured pool and rejects unknown persisted keys", () => {
  const { audit, env } = fixture();
  env.UV_THREADPOOL_SIZE = "0";
  const started = startAudit({
    env,
    argv: [process.execPath, env.PI_ORB_TEST_AUDIT_ENTRY],
    pid: 123,
  })._unsafeUnwrap();
  cleanups.push(started.stop);
  const file = join(audit.directory, `${orb}-123.json`);
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  expect(snapshot.startup.configuredThreadpoolSize).toBeNull();
  writeFileSync(file, JSON.stringify({ ...snapshot, secret: "SECRET" }));
  expect(audit.read(orb)._unsafeUnwrapErr().type).toBe("audit_invalid");
  rmSync(audit.directory, { recursive: true });
  expect(() =>
    channel("undici:request:create").publish({
      request: { origin: env.PI_ORB_TEST_AUDIT_ORIGIN, path: env.PI_ORB_TEST_AUDIT_PATH },
    }),
  ).not.toThrow();
});

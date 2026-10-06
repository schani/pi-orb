import { execFile } from "node:child_process";
import { chmod, chown, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const helper = new URL("../../../infra/native-vm/claude-receipt-edge.mjs", import.meta.url).href;

it("reserves cleanup and trace-export time inside the caller's 120-second deadline", async () => {
  const source = await readFile("infra/native-vm/claude-acceptance.sh", "utf8");
  const namespace = source.match(/timeout --kill-after=(\d+)s (\d+)s[^;\n]*\n\s+unshare/);
  const cleanup = source.match(/timeout --kill-after=(\d+)s (\d+)s rm/);
  expect(
    Number(namespace?.[1]) + Number(namespace?.[2]) + Number(cleanup?.[1]) + Number(cleanup?.[2]),
  ).toBeLessThanOrEqual(116);
});

it("retains only bounded causal metadata, never native or normalized payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-safe-trace-"));
  const script = join(directory, "probe.mjs");
  await writeFile(
    script,
    `
import assert from "node:assert/strict";
import { readFile, writeFile, rm, chmod } from "node:fs/promises";
import { safeQualificationEvidence, persistQualificationTrace, nativeQualificationRows } from ${JSON.stringify(helper)};
const directory = ${JSON.stringify(directory)};
const privateValue = "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT https://private.invalid/?code=private-code Bearer sk-private-token ENV=private-value";
const id = "00000000-0000-4000-8000-000000000029";
const native = directory + "/native.jsonl";
await writeFile(native, JSON.stringify({ type: "assistant", uuid: id, parentUuid: id, sessionId: id, message: { content: privateValue }, env: privateValue }) + "\\n");
const rows = await nativeQualificationRows(native);
assert(rows.isOk());
const evidence = safeQualificationEvidence({ incarnation: "1", health: { status: "failed", error: { code: "claude_stream_identity_gap", message: privateValue } }, snapshot: { session: { id }, records: [{ id, type: "message", role: "assistant", content: privateValue, metadata: privateValue }] }, nativeRows: rows.value, streamRows: [{ uuid: id, type: "assistant", parent_tool_use_id: privateValue, message: privateValue }], pendingBlocks: [{ index: 0, type: "text", text: privateValue }], operationFailure: privateValue });
assert.equal(evidence.health.code, "claude_stream_identity_gap");
assert.equal(evidence.nativeRows[0].uuid, id);
assert.equal(evidence.pendingBlocks[0].type, "text");
const destination = directory + "/trace.json";
assert(persistQualificationTrace(destination, { phase: "test", evidence }).isOk());
const retained = await readFile(destination, "utf8");
assert(!retained.includes(privateValue));
await rm(native);
assert.equal(await readFile(destination, "utf8"), retained);
const many = safeQualificationEvidence({ health: { status: "failed", error: { code: privateValue } }, snapshot: { records: Array.from({ length: 10000 }, () => ({ id, type: "message", content: privateValue })) } });
assert(many.records.length <= 128);
assert.equal(many.health.code, "runtime_failure");
const oversized = persistQualificationTrace(destination, { padding: "x".repeat(192 * 1024) });
assert(oversized.isErr());
assert.equal(oversized.error.code, "qualification_trace_size_exceeded");
assert.equal(await readFile(destination, "utf8"), retained);
await chmod(directory, 0o500);
const denied = persistQualificationTrace(destination, { phase: "changed" });
assert(denied.isErr());
assert.equal(denied.error.code, "qualification_trace_write_failed");
assert.equal(await readFile(destination, "utf8"), retained);
await chmod(directory, 0o700);
console.log(JSON.stringify(evidence));
`,
  );
  try {
    await chmod(script, 0o644);
    const root = process.getuid?.() === 0;
    if (root) await chown(directory, 62000, 62000);
    const result = await execute(
      root ? "setpriv" : process.execPath,
      root
        ? ["--reuid=62000", "--regid=62000", "--clear-groups", process.execPath, script]
        : [script],
      {
        env: { PATH: process.env["PATH"] },
        timeout: 5_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(
      /PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT|private\.invalid|sk-private-token|private-code|private-value/,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      health: { code: "claude_stream_identity_gap" },
    });
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

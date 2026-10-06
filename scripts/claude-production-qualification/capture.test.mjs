import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { err, ok } from "neverthrow";
import {
  createNativeEvidenceCapture,
  safeQualificationEvidence,
} from "../../infra/native-vm/claude-receipt-edge.mjs";

test("failed health still captures native identity; failed reads retain the last valid capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-capture-"));
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const uuid = "00000000-0000-4000-8000-000000000002";
  const file = join(directory, `${sessionId}.jsonl`);
  let failed = false;
  let snapshotCalls = 0;
  const agent = {
    sessionId: () => sessionId,
    replicationSnapshot: () => {
      snapshotCalls++;
      return failed
        ? err({ code: "claude_stream_identity_gap" })
        : ok({ session: { id: sessionId }, records: [] });
    },
  };
  const capture = createNativeEvidenceCapture(agent, directory);
  try {
    await writeFile(
      file,
      JSON.stringify({
        type: "assistant",
        uuid,
        sessionId,
        parentUuid: null,
        message: {
          id: "secret-message-id",
          stop_reason: "end_turn",
          content: "secret-payload",
        },
      }) + "\n",
    );
    const ready = await capture();
    failed = true;
    const unhealthy = await capture();
    assert.equal(snapshotCalls, 0, "native observation must not flush public history");
    assert.equal(unhealthy.sessionId, sessionId);
    assert.equal(unhealthy.nativeCapture.status, "captured");
    assert.deepEqual(unhealthy.nativeRows, ready.nativeRows);
    assert.equal(unhealthy.nativeRows[0].uuid, uuid);
    assert.equal(unhealthy.nativeRows[0].stopReason, "end_turn");
    await writeFile(file, "invalid-json\n"); // controlled parse failure
    const unavailable = await capture();
    assert.equal(unavailable.nativeCapture.status, "error");
    assert.equal(unavailable.nativeCapture.code, "qualification_native_trace_unavailable");
    assert.equal(unavailable.nativeCapture.retained, true);
    assert.deepEqual(unavailable.nativeRows, ready.nativeRows);
    const safe = JSON.stringify(safeQualificationEvidence(unavailable));
    assert(!safe.includes("secret"));
    assert(safe.includes(sessionId));
    const uncaptured = await createNativeEvidenceCapture(agent, directory)();
    assert.equal(uncaptured.nativeCapture.retained, false);
    assert.equal(uncaptured.nativeRows, null);
    assert.equal(safeQualificationEvidence(uncaptured).nativeRows, null);
    assert.equal(snapshotCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

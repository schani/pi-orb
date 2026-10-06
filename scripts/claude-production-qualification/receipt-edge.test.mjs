import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableReceiptEdge } from "../../infra/native-vm/claude-receipt-edge.mjs";

test("durable edge excludes unrelated UUIDs and partial native lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-receipt-edge-"));
  const native = join(directory, "native.jsonl");
  const state = join(directory, "session.json");
  await writeFile(native, '{"type":"user","uuid":"other"}\n');
  await writeFile(state, JSON.stringify({ deliveries: { inbox: { uuid: "expected" } } }));
  const edge = durableReceiptEdge(native, state, "inbox");
  let settled = false;
  edge.promise.then(() => {
    settled = true;
  });
  try {
    await edge.inspect();
    assert.equal(settled, false);
    await writeFile(native, '{"type":"user","uuid":"expected"}');
    await edge.inspect();
    assert.equal(settled, false);
    await writeFile(native, '{"type":"user","uuid":"expected"}\n');
    await edge.inspect();
    await edge.promise;
    assert.equal(settled, true);
  } finally {
    edge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native file replacement does not detach the receipt observation", {
  timeout: 2000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-receipt-replacement-"));
  const native = join(directory, "native.jsonl");
  const replacement = join(directory, "replacement.jsonl");
  const state = join(directory, "session.json");
  await writeFile(native, '{"type":"user","uuid":"old"}\n');
  await writeFile(replacement, '{"type":"user","uuid":"old"}\n');
  await writeFile(state, JSON.stringify({ deliveries: { inbox: { uuid: "expected" } } }));
  let inspectedReplacement;
  const observed = new Promise((resolve) => {
    inspectedReplacement = resolve;
  });
  const edge = durableReceiptEdge(native, state, "inbox", () => inspectedReplacement());
  context.after(async () => {
    edge.close();
    await rm(directory, { recursive: true, force: true });
  });
  await rename(replacement, native);
  await observed;
  await appendFile(native, '{"type":"user","uuid":"expected"}\n');
  await edge.promise;
});

test("an atomic journal can arrive before the matching native write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-receipt-edge-"));
  const native = join(directory, "native.jsonl");
  const state = join(directory, "session.json");
  await writeFile(native, '{"type":"user","uuid":"old"}\n');
  await writeFile(state, JSON.stringify({ deliveries: {} }));
  const edge = durableReceiptEdge(native, state, "inbox");
  let settled = false;
  edge.promise.then(() => {
    settled = true;
  });
  try {
    await writeFile(state, JSON.stringify({ deliveries: { inbox: { uuid: "expected" } } }));
    await edge.inspect();
    assert.equal(settled, false);
    await writeFile(native, '{"type":"user","uuid":"old"}\n{"type":"user","uuid":"expected"}\n');
    await edge.promise;
    assert.equal(settled, true);
  } finally {
    edge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

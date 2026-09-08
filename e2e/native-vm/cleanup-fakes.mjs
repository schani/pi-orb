import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteFakeSession, FAKE_ORIGIN } from "../harness.ts";

const root = process.env.NATIVE_VM_EVIDENCE ?? ".context/native-vm";
const f = JSON.parse(readFileSync(`${root}/fixture.json`, "utf8"));
const keys = new Set(
  [f.fake, f.nameFake, ...(f.previousFakes ?? [])].filter(Boolean).map((x) => x.sessionKey),
);
for (const key of keys) {
  await deleteFakeSession(key);
  const response = await fetch(`${FAKE_ORIGIN}/api/__mock__/sessions/${key}`);
  assert.equal(response.status, 404);
}
console.log(`removed ${keys.size} experiment mock sessions`);

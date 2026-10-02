import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const packagePath = join(
  dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))),
  "package.json",
);

test("Pi AI 1.0.0 bundles OpenAI GPT-6.1 Sol", () => {
  assert.equal(JSON.parse(readFileSync(packagePath, "utf8")).version, "1.0.0");
  const model = getBuiltinModel("openai", "gpt-6.1-sol");
  assert.equal(model.id, "gpt-6.1-sol");
  assert.equal(model.provider, "openai");
  assert.equal(model.reasoning, true);
  assert.ok(model.input.includes("image"));
});

test("Pi AI bundles Codex GPT-6.1 Sol", () => {
  const model = getBuiltinModel("openai-codex", "gpt-6.1-sol");
  assert.equal(model.id, "gpt-6.1-sol");
  assert.equal(model.provider, "openai-codex");
  assert.equal(model.reasoning, true);
  assert.ok(model.input.includes("image"));
});

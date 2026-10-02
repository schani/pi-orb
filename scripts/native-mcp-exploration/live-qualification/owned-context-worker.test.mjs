import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedWorkerTools } from "./owned-context-worker.mjs";

const inventory = ["cloudflare", "datadog"].flatMap((server) =>
  Array.from({ length: server === "cloudflare" ? 3 : 33 }, (_, index) => ({
    name: `mcp__${server}__read_${index}`,
  })),
);
test("worker allowlist is exact, namespace-fenced and excludes active search", () => {
  assert.deepEqual(approvedWorkerTools(inventory, true), [
    "codemode",
    ...inventory.map((tool) => tool.name).sort(),
  ]);
  assert.deepEqual(approvedWorkerTools([], false), ["codemode"]);
  assert.equal(approvedWorkerTools(inventory, false), undefined);
  assert.equal(approvedWorkerTools(inventory.slice(1), true), undefined);
  assert.equal(approvedWorkerTools([...inventory.slice(1), inventory[1]], true), undefined);
  assert.equal(
    approvedWorkerTools([...inventory.slice(1), { name: "mcp__evil__read" }], true),
    undefined,
  );
  assert.equal(
    approvedWorkerTools(
      [...inventory.slice(1), { name: "mcp__cloudflare__read,write\nmodel: evil" }],
      true,
    ),
    undefined,
  );
});

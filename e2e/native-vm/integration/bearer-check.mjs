import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const { token } = JSON.parse(readFileSync(`${root}/old-bearer.json`));
const response = await fetch("http://127.0.0.1:18100/runtime/v1/id-token", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ audience: "pi-orb-native-integration" }),
});
const body = await response.json();
const result = { status: response.status, error: body.error };
writeFileSync(`${root}/bearer-revoked.json`, JSON.stringify(result));
assert.equal(response.status, 401);
assert.equal(body.error, "unauthorized");
console.log("OLD_BEARER_REVOKED");

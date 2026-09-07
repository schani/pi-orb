// Run inside the VM under systemd with its protected EnvironmentFile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";

const audience = "https://native-vm.example.invalid";
const token = execFileSync("/usr/local/bin/pi-orb", ["id-token", "--audience", audience], {
  encoding: "utf8",
}).trim();
const [headerPart, claimsPart, signature] = token.split(".");
const header = JSON.parse(Buffer.from(headerPart, "base64url"));
const claims = JSON.parse(Buffer.from(claimsPart, "base64url"));
assert.equal(header.alg, "RS256");
assert.equal(claims.aud, audience);
assert.equal(claims.sub, process.env["PI_ORB_ID"]);
assert(claims.exp > Date.now() / 1000);
const discovery = await fetch(`${claims.iss}/.well-known/openid-configuration`).then((r) =>
  r.json(),
);
const jwks = await fetch(discovery.jwks_uri).then((r) => r.json());
const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
assert(key);
assert(
  verify(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${claimsPart}`),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  ),
);
console.log("BROKER_IDENTITY_SIGNATURE_OK");

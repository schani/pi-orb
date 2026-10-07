import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { HmacPreviewVerifier } from "./admission.ts";

const target = {
  orbId: "orb",
  port: 3000,
  registrationId: "generation",
  incarnation: 2,
  executionId: "execution",
  runtimeInstanceId: "runtime",
};
function sign(expiresAt: number, token = "secret") {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, target, origin: "https://preview.example", expiresAt }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", createHash("sha256").update(token).digest("hex")).update(`pi-orb-preview-admission-v1\n${payload}`).digest("base64url")}`;
}
it("authenticates a purpose-bound exact envelope with a ten-second maximum lifetime", () => {
  const verifier = new HmacPreviewVerifier("secret");
  expect(verifier.verify(sign(10001), 1)._unsafeUnwrap().target).toEqual(target);
  for (const grant of [
    sign(1),
    sign(10002),
    sign(9999, "wrong"),
    `${sign(9999)}.extra`,
    "Bearer hash",
    "a".repeat(8193),
  ])
    expect(verifier.verify(grant, 1).isErr()).toBe(true);
});

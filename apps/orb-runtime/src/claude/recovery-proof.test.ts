import { expect, it } from "vitest";
import { readClaudeRecoveryProof } from "./recovery-proof.ts";

it("accepts only bounded exact launch proof fields", () => {
  const proof = { episode: "a".repeat(64), disposedIncarnation: 0, replacementIncarnation: 1 };
  expect(readClaudeRecoveryProof(JSON.stringify(proof))).toEqual(proof);
  for (const value of [
    undefined,
    "",
    "{",
    "a".repeat(513),
    JSON.stringify({ ...proof, verified: true }),
    JSON.stringify({ ...proof, episode: "secret" }),
  ])
    expect(readClaudeRecoveryProof(value)).toBeUndefined();
});

import { expect, it } from "vitest";
import { googleIdentityMigrationInput } from "./google-identity-migration-input.ts";

const mapping = {
  userId: "00000000-0000-4000-8000-000000000001",
  oldIssuer: "https://cloud.google.com/iap",
  oldSubject: "old",
  googleSubject: "google",
};
it("accepts only explicit nonsecret exact mappings, with no input needed for fresh databases", () => {
  expect(googleIdentityMigrationInput({})._unsafeUnwrap()).toBeUndefined();
  expect(
    googleIdentityMigrationInput({
      PI_ORB_GOOGLE_IDENTITY_MAPPINGS: JSON.stringify([mapping]),
    })._unsafeUnwrap(),
  ).toEqual([mapping]);
});
for (const input of [
  "",
  "bad json",
  "null",
  "{}",
  JSON.stringify([null]),
  JSON.stringify([{ ...mapping, email: "x" }]),
  JSON.stringify([{ ...mapping, userId: "bad" }]),
  JSON.stringify([{ ...mapping, oldIssuer: "iap" }]),
  JSON.stringify([{ ...mapping, googleSubject: " " }]),
  JSON.stringify([{ ...mapping, googleSubject: 42 }]),
  JSON.stringify([{ ...mapping, oldSubject: undefined }]),
]) {
  it(`rejects malformed mapping input ${input}`, () => {
    const result = googleIdentityMigrationInput({ PI_ORB_GOOGLE_IDENTITY_MAPPINGS: input });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe(
      "PI_ORB_GOOGLE_IDENTITY_MAPPINGS must be an array of exact verified identity mappings",
    );
  });
}

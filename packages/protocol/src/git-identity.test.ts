import { expect, it } from "vitest";
import { GIT_IDENTITY_MAX_CHARS, validateGitIdentity } from "./git-identity.ts";

it("accepts a complete or cleared identity verbatim", () => {
  for (const identity of [
    { name: "", email: "" },
    { name: "Ada Lovelace", email: "ada@example.com" },
    { name: "Zoë 🪐", email: "123456+zoe@users.noreply.github.com" },
    {
      name: "x".repeat(GIT_IDENTITY_MAX_CHARS),
      email: `${"y".repeat(GIT_IDENTITY_MAX_CHARS - 4)}@b.c`,
    },
  ])
    expect(validateGitIdentity(identity)._unsafeUnwrap()).toEqual(identity);
});

it("rejects emails that are not addresses", () => {
  for (const email of [
    "not-policed",
    "a@b",
    "@b.c",
    "a@.c",
    "a@b.",
    "a@@b.c",
    "a b@c.d",
    "a@b c.d",
  ])
    expect(validateGitIdentity({ name: "Ada", email })._unsafeUnwrapErr().message).toBe(
      "user.email must be an email address",
    );
});

it("rejects malformed, half-set, oversized, control-character and angle-bracket values", () => {
  for (const body of [
    null,
    {},
    { name: "Ada" },
    { name: 1, email: "" },
    { name: "Ada", email: "a@b.c", extra: true },
    { name: "Ada", email: "" },
    { name: "", email: "a@b.c" },
    { name: "x".repeat(GIT_IDENTITY_MAX_CHARS + 1), email: "a@b.c" },
    { name: "Ada\nEvil", email: "a@b.c" },
    { name: "Ada", email: "a@b.c\0" },
    { name: "Ada\t", email: "a@b.c" },
    { name: "Ada\u007f", email: "a@b.c" },
    { name: "Ada", email: "<a@b.c>" },
    { name: "Ada >", email: "a@b.c" },
    { name: "\ud800", email: "a@b.c" },
  ])
    expect(validateGitIdentity(body).isErr()).toBe(true);
});

import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { authenticatedGitCredentials } from "./credentials.ts";

it("only requests scoped owner credentials for recognized Github HTTPS repositories", async () => {
  const requests: string[] = [];
  const credentials = authenticatedGitCredentials((orbId) => {
    requests.push(orbId);
    return okAsync("secret");
  });
  const signal = new AbortController().signal;
  const env = (
    await credentials.environment("https://github.com/acme/repo.git", signal, "orb")
  )._unsafeUnwrap();
  expect(env.GIT_CONFIG_KEY_0).toBe("http.followRedirects");
  expect(env.GIT_CONFIG_VALUE_0).toBe("false");
  expect(env.GIT_CONFIG_VALUE_1).toContain(Buffer.from("x-access-token:secret").toString("base64"));
  expect(env.GIT_CONFIG_KEY_1).toBe("http.https://github.com/.extraHeader");
  for (const url of [
    "https://evil.test/o/r",
    "https://github.com.evil.test/o/r",
    "https://user:pass@github.com/o/r",
    "http://github.com/o/r",
    "https://github.com/o/r?secret=x",
  ])
    expect((await credentials.environment(url, signal, "other")).isErr()).toBe(true);
  expect(requests).toEqual(["orb"]);
});
it("allows public Git access without an owner grant but never hides credential errors", async () => {
  const signal = new AbortController().signal;
  const publicAccess = authenticatedGitCredentials(() => okAsync(null));
  const env = (
    await publicAccess.environment("https://github.com/o/r", signal, "orb")
  )._unsafeUnwrap();
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GIT_CONFIG_KEY_0).toBe("http.followRedirects");
  expect(env.GIT_CONFIG_VALUE_0).toBe("false");
  expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
  expect(env.GIT_CONFIG_VALUE_1).toBe("");
  expect(Object.values(env).join(" ")).not.toContain("Authorization");
  const failed = authenticatedGitCredentials(() =>
    errAsync(resourceError("storage", "unavailable")),
  );
  expect((await failed.environment("https://github.com/o/r", signal, "orb")).isErr()).toBe(true);
});

it("does not publish credentials after cancellation", async () => {
  const abort = new AbortController();
  const c = authenticatedGitCredentials(() => {
    abort.abort();
    return okAsync("secret");
  });
  expect((await c.environment("https://github.com/o/r", abort.signal, "o")).isErr()).toBe(true);
});

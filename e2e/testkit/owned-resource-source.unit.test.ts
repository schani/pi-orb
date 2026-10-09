import { pathToFileURL } from "node:url";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { resourceError } from "../../apps/control-plane/src/domain/resources.ts";
import { localGitEnvironment } from "./cross-axis.ts";
import { localOwnedGitCredentials } from "./owned-resource-source.ts";

it("resolves real owner credentials for the original URL before adding isolated Git transport", async () => {
  const signal = new AbortController().signal;
  const calls: unknown[] = [];
  const observed: unknown[] = [];
  const original = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "synthetic-owner-header",
  };
  const credentials = localOwnedGitCredentials(
    {
      environment: (url, receivedSignal, orbId) => {
        calls.push({ url, signal: receivedSignal, orbId });
        return okAsync(original);
      },
    },
    "/tmp/owned-fixture",
    (orbId, environment) => observed.push({ orbId, environment }),
  );
  const url = "https://github.com/schani/pi-orb";
  const result = (await credentials.environment(url, signal, "alice-child"))._unsafeUnwrap();
  expect(calls).toEqual([{ url, signal, orbId: "alice-child" }]);
  expect(observed).toEqual([{ orbId: "alice-child", environment: original }]);
  expect(result).toMatchObject({ ...original, GIT_CONFIG_COUNT: "3" });
  expect(original.GIT_CONFIG_COUNT).toBe("1");
  expect(result.GIT_CONFIG_KEY_1).toBe(`url.${pathToFileURL("/tmp/owned-fixture").href}.insteadOf`);
  expect(result.GIT_CONFIG_VALUE_1).toBe(url);
  expect(result.GIT_CONFIG_KEY_2).toBe("protocol.file.allow");
  expect(localGitEnvironment("/tmp/owned-fixture", url).GIT_CONFIG_VALUE_0).toBe(url);
});

it("preserves credential refusal without observation or local transport", async () => {
  const failure = resourceError("authentication", "credential refusal");
  let observations = 0;
  const credentials = localOwnedGitCredentials(
    { environment: () => errAsync(failure) },
    "/tmp/owned-fixture",
    () => observations++,
  );
  const result = await credentials.environment(
    "https://github.com/schani/pi-orb",
    new AbortController().signal,
    "alice-child",
  );
  expect(result.isErr()).toBe(true);
  expect(result._unsafeUnwrapErr()).toBe(failure);
  expect(observations).toBe(0);
});

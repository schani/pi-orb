import { expect, it } from "vitest";
import { parseE2eRuntimeEnvironment } from "./e2e-runtime-environment.ts";

it("passes a JSON object of strings through and treats empty as none", () => {
  expect(parseE2eRuntimeEnvironment("")._unsafeUnwrap()).toEqual({});
  expect(
    parseE2eRuntimeEnvironment('{"GIT_CONFIG_COUNT":"1","GIT_CONFIG_KEY_0":"k"}')._unsafeUnwrap(),
  ).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "k" });
});

it.each(["{", "[]", '"x"', '{"A":1}', '{"A":null}'])("rejects %s", (value) => {
  expect(parseE2eRuntimeEnvironment(value).isErr()).toBe(true);
});

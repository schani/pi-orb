import { expect, it } from "vitest";
import { appendModelStage } from "./durable-stage-rules.ts";

it("appends stages at the preserved cursor without resetting credentials", async () => {
  const original = [{ id: 0 }, { id: 1 }, { id: 2 }];
  let scenario = { auth: { accountId: "mock" }, model: { rules: original } };
  let cursor = 3;
  const tokens = ["mock-token"];
  const deviceCodes = ["mock-device-code"];
  const calls: { path: string; body?: unknown }[] = [];
  const control = async (_key: string, path: string, body?: unknown) => {
    calls.push({ path, ...(body === undefined ? {} : { body }) });
    if (path === "") return { scenario, cursor };
    if (path === "/state") return { cursor, tokens: [...tokens], deviceCodes: [...deviceCodes] };
    if (path === "/reset") {
      cursor = 0;
      tokens.length = 0;
      deviceCodes.length = 0;
    }
    if (path === "/scenario") scenario = body as typeof scenario;
    return {};
  };
  const before = await control("mock-session", "/state");
  await appendModelStage("mock-session", [{ id: 3 }, { id: 4 }], control);
  await appendModelStage("mock-session", [{ id: 5 }], control);
  expect(scenario.model.rules.map((rule) => rule.id)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(scenario.model.rules[cursor]).toEqual({ id: 3 });
  expect(scenario.auth).toEqual({ accountId: "mock" });
  expect(await control("mock-session", "/state")).toEqual(before);
  expect(calls.map((call) => call.path)).toEqual([
    "/state",
    "",
    "/scenario",
    "",
    "/scenario",
    "/state",
  ]);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSpawnArgs, requestSpawn } from "./command.ts";

const id = "00000000-0000-4000-8000-000000000003";
const env = { controlPlaneUrl: "https://runtime.test", runtimeToken: "private-token" };
afterEach(() => vi.unstubAllGlobals());
describe("spawn command", () => {
  it("parses prompt sources, retry ID, name and JSON", () => {
    expect(
      parseSpawnArgs([
        "--prompt-file",
        "-",
        "--id",
        id,
        "--name",
        "Tests",
        "--json",
      ])._unsafeUnwrap(),
    ).toEqual({ source: { file: "-" }, id, name: "Tests", json: true });
    expect(parseSpawnArgs(["--prompt", "work"]).isOk()).toBe(true);
  });
  it.each([
    [],
    ["--prompt"],
    ["--prompt", ""],
    ["--prompt", "a", "--prompt-file", "b"],
    ["--id", "oops", "--prompt", "a"],
    ["--prompt", "a", "--unknown"],
    ["--prompt", "a", "--prompt", "b"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(parseSpawnArgs(args).isErr()).toBe(true);
  });
  it("sends a stable ID to the runtime role and returns its browser URL", async () => {
    const response = {
      orbId: id,
      messageId: id,
      projectId: "project",
      url: `https://browser.test/#/orbs/${id}`,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await requestSpawn(env, id, { prompt: "work" }))._unsafeUnwrap()).toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      `https://runtime.test/runtime/v1/orbs/${id}/spawn`,
      expect.objectContaining({ method: "PUT", body: '{"prompt":"work"}' }),
    );
  });
  it("reports unknown acceptance and preserves the retry ID after response loss", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret transport details")));
    const result = await requestSpawn(env, id, { prompt: "work" });
    expect(result.isErr() && result.error.message).toContain(`--id ${id}`);
    expect(result.isErr() && result.error.message).not.toContain("secret");
  });
});

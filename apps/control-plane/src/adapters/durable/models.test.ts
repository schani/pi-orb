import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { createDurableModels } from "./models.ts";

describe("central broker ModelRuntime", () => {
  it("resolves owner credentials without changing process agent directory", async () => {
    const before = process.env["PI_CODING_AGENT_DIR"];
    const runtime = await createDurableModels({
      token: () =>
        okAsync({ accessToken: "owner-bearer", generation: 4, expiresAt: Date.now() + 3600000 }),
    });
    expect(runtime.isOk()).toBe(true);
    const auth = await runtime._unsafeUnwrap().getAuth("openai-codex");
    expect(auth?.auth.apiKey).toBe("owner-bearer");
    expect(process.env["PI_CODING_AGENT_DIR"]).toBe(before);
  });
});

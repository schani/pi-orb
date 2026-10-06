import { describe, expect, it } from "vitest";
import { claudeChildEnvironment, fetchClaudeSubscription, verifyClaudeAccount } from "./auth.ts";

describe("Claude subscription boundary", () => {
  it("requires effective first-party subscription environment auth, rejecting configured API/provider overrides", () => {
    const account = {
      apiProvider: "firstParty" as const,
      apiKeySource: "none",
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
    };
    expect(verifyClaudeAccount(account).isOk()).toBe(true);
    expect(
      verifyClaudeAccount({
        apiProvider: "firstParty",
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      }).isOk(),
    ).toBe(true);
    for (const override of [
      { apiProvider: "gateway" as const },
      { apiProvider: "vertex" as const },
      { apiKeySource: "ANTHROPIC_API_KEY" },
      { apiKeySource: "apiKeyHelper" },
      { tokenSource: "oauth" },
    ]) {
      expect(verifyClaudeAccount({ ...account, ...override }).isErr()).toBe(true);
    }
    expect(verifyClaudeAccount({ apiProvider: "firstParty", apiKeySource: "none" }).isErr()).toBe(
      true,
    );
  });
  it("vends through incarnation bearer and never publishes the token to runtime env", async () => {
    let called = false;
    const result = await fetchClaudeSubscription(
      { controlPlaneUrl: "http://cp", runtimeToken: "guest" },
      async (url, init) => {
        expect(url).toBe("http://cp/runtime/v1/claude-subscription");
        expect(init?.headers).toEqual({
          authorization: "Bearer guest",
          "content-type": "application/json",
        });
        expect(init?.body).toBe("{}");
        called = true;
        return new Response(JSON.stringify({ token: "subscription", generation: 3 }));
      },
    );
    expect(called).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ token: "subscription", generation: 3 });
    const base = {
      HOME: "/home",
      ANTHROPIC_API_KEY: "api",
      ANTHROPIC_AUTH_TOKEN: "api2",
      ANTHROPIC_BASE_URL: "http://api",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "other",
      CLAUDE_CONFIG_DIR: "/other",
      BASH_ENV: "/profile",
      PATH: "/bin",
    };
    const env = claudeChildEnvironment(base, "subscription", "/private");
    expect(env).toEqual({
      HOME: "/home",
      PATH: "/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      CLAUDE_CONFIG_DIR: "/private",
    });
    expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe("other");
  });
  it.each([401, 409, 500])("rejects HTTP %s without leaking bodies", async (status) => {
    const result = await fetchClaudeSubscription(
      { controlPlaneUrl: "http://cp", runtimeToken: "guest" },
      async () => new Response("secret", { status }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).not.toContain("secret");
  });
  it("rejects malformed success and maps transport rejection", async () => {
    const broker = { controlPlaneUrl: "http://cp", runtimeToken: "guest" };
    expect(
      (await fetchClaudeSubscription(broker, async () => new Response('{"token":""}'))).isErr(),
    ).toBe(true);
    expect(
      (await fetchClaudeSubscription(broker, () => Promise.reject("secret")))._unsafeUnwrapErr()
        .message,
    ).not.toContain("secret");
  });
});

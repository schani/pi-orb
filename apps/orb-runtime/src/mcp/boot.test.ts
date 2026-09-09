import { describe, expect, it } from "vitest";
import { resolveMcpHeaders } from "./boot.ts";

describe("MCP boot credentials", () => {
  it("resolves only the project snapshot literally; missing values never become unauthenticated requests", () => {
    const config = {
      name: "x",
      description: "test",
      url: "https://example.com/mcp",
      headers: {
        Authorization: { secret: "TOKEN", prefix: "Bearer " as const },
        "x-project": { literal: "123" },
      },
    };
    expect(resolveMcpHeaders(config, { TOKEN: "!not-a-command" })._unsafeUnwrap()).toEqual({
      Authorization: "Bearer !not-a-command",
      "x-project": "123",
    });
    expect(resolveMcpHeaders(config, {}).isErr()).toBe(true);
    expect(JSON.stringify(resolveMcpHeaders(config, { TOKEN: "private\r\nvalue" }))).not.toContain(
      "private",
    );
    expect(resolveMcpHeaders(config, { TOKEN: "private\r\nvalue" }).isErr()).toBe(true);
  });
});

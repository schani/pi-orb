import { expect, it } from "vitest";
import { isPublicMcpAddress, validateMcpEndpoint } from "./mcp-probe.ts";

it("rejects metadata, loopback, private, mapped-private, and non-HTTPS endpoints", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
  ])
    expect(isPublicMcpAddress(address)).toBe(false);
  expect(isPublicMcpAddress("1.1.1.1")).toBe(true);
  for (const url of [
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://[::1]/mcp",
    "https://169.254.169.254/",
    "https://localhost/mcp",
  ])
    expect(validateMcpEndpoint(url).isErr()).toBe(true);
  expect(validateMcpEndpoint("https://mcp.cloudflare.com/mcp").isOk()).toBe(true);
});

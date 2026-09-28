import { describe, expect, it } from "vitest";
import { portExposurePrompt } from "./prompt.ts";

const host = "pi-orb-abc123.tail1234.ts.net";

describe("portExposurePrompt", () => {
  it("gives one full HTTP URL and tells the agent to substitute the actual port", () => {
    const prompt = portExposurePrompt(host);
    expect(prompt.match(new RegExp(host.replaceAll(".", "\\."), "g"))).toHaveLength(1);
    expect(prompt).toContain(`http://${host}:5173`);
    expect(prompt).toMatch(/(?:replace|substitute|use).*actual port/i);
    expect(prompt).toMatch(/always.*(?:share|tell).*full.*URL/i);
    expect(prompt).toMatch(/starting.*service.*user.*open/i);
  });

  it("explains private tailnet forwarding without requiring special binding", () => {
    const prompt = portExposurePrompt(host);
    expect(prompt).toMatch(/user's private.*tailnet/i);
    expect(prompt).toMatch(/exposes every TCP listening port to the user/i);
    expect(prompt).toMatch(/tailscaled.*userspace/i);
    expect(prompt).toMatch(/inbound.*same localhost port/i);
    expect(prompt).toMatch(
      /(?:bind.*localhost.*127\.0\.0\.1).*no special binding or extra configuration/i,
    );
  });

  it("warns that the URLs are plain http", () => {
    expect(portExposurePrompt(host)).toMatch(/HTTP only.*no TLS/i);
  });

  it("starts with its own heading so it appends cleanly", () => {
    expect(portExposurePrompt(host).startsWith("## Port exposure\n")).toBe(true);
  });
});

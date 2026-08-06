import { describe, expect, it } from "vitest";
import { portExposurePrompt } from "./prompt.ts";

const host = "pi-orb-abc123.tail1234.ts.net";

describe("portExposurePrompt", () => {
  it("names the preview host and the URL shape the user opens", () => {
    const prompt = portExposurePrompt(host);
    expect(prompt).toContain(`\`${host}\``);
    expect(prompt).toContain(`http://${host}:<port>`);
    expect(prompt).toContain(`http://${host}:5173`);
  });

  it("tells the agent that binding to localhost is enough", () => {
    expect(portExposurePrompt(host)).toContain("localhost or 127.0.0.1 is sufficient");
  });

  it("warns that the URLs are plain http", () => {
    expect(portExposurePrompt(host)).toContain("no TLS");
  });

  it("starts with its own heading so it appends cleanly", () => {
    expect(portExposurePrompt(host).startsWith("## Port exposure\n")).toBe(true);
  });
});

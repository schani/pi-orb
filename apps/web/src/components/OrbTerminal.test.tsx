import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbTerminal, terminalCloseMessage } from "./OrbTerminal.tsx";

describe("OrbTerminal", () => {
  it("starts as an accessible header icon without creating a terminal", () => {
    const html = renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled onClose={() => {}} />);
    expect(html).toContain('class="icon-button"');
    expect(html).toContain('aria-label="Open terminal"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-keyshortcuts="Meta+J"');
    expect(html).toContain('href="#i-terminal"');
    expect(html).not.toContain(">terminal<");
    expect(html).not.toContain("orb-terminal-window");
  });

  it("renders nothing when the orb cannot run a terminal", () => {
    expect(
      renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled={false} onClose={() => {}} />),
    ).toBe("");
  });
  it("identifies only the fixed rollout close without reopening a terminal", () => {
    expect(terminalCloseMessage({ code: 1012, reason: "deployment rollover" })).toBe(
      "Terminal interrupted by deployment.",
    );
    expect(terminalCloseMessage({ code: 1012, reason: "untrusted close detail" })).toBe(
      "Terminal connection closed.",
    );
    expect(terminalCloseMessage({ code: 1006, reason: "deployment rollover" })).toBe(
      "Terminal connection closed.",
    );
  });
});

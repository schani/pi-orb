import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbTerminal } from "./OrbTerminal.tsx";

describe("OrbTerminal", () => {
  it("starts as an accessible header icon without creating a terminal", () => {
    const html = renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled />);
    expect(html).toContain('class="icon-button"');
    expect(html).toContain('aria-label="Open terminal"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-keyshortcuts="Meta+J"');
    expect(html).toContain('href="#i-terminal"');
    expect(html).not.toContain(">terminal<");
    expect(html).not.toContain("orb-terminal-window");
  });

  it("renders nothing when the orb cannot run a terminal", () => {
    expect(renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled={false} />)).toBe("");
  });
});

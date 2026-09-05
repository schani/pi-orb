import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbTerminal } from "./OrbTerminal.tsx";

describe("OrbTerminal", () => {
  it("starts as a bordered launcher without creating a terminal", () => {
    const html = renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled />);
    expect(html).toContain('class="orb-terminal-launcher"');
    expect(html).toContain(">terminal<");
    expect(html).not.toContain("orb-terminal-window");
  });

  it("renders nothing when the orb cannot run a terminal", () => {
    expect(renderToStaticMarkup(<OrbTerminal orbId="orb-1" enabled={false} />)).toBe("");
  });
});

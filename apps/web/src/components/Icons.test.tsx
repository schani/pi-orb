import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, IconSprite } from "./Icons.tsx";

describe("utility icons", () => {
  it("draws every utility icon on one 16px grid at one stroke", () => {
    const html = renderToStaticMarkup(<IconSprite />);
    const bin = html.match(/<symbol id="i-bin"[^>]*>.*?<\/symbol>/)?.[0];
    expect(bin).toContain('viewBox="0 0 16 16"');
    expect(bin).toContain('stroke-width="1.5"');
    expect(bin).toContain('stroke-linecap="square"');
    expect(bin).toContain('stroke="currentColor"');
    expect(bin).toContain('fill="none"');
    expect(bin).toContain('d="M2 4h12M6 4V2h4v2M4 6v8h8V6M6.5 7v4M9.5 7v4"');
    expect(html).not.toContain('viewBox="0 0 24 24"');
    expect(html).not.toContain('stroke-width="1.9"');
  });

  it("draws the selected bare terminal prompt on the same 16px utility grid", () => {
    const html = renderToStaticMarkup(<IconSprite />);
    const terminal = html.match(/<symbol id="i-terminal"[^>]*>.*?<\/symbol>/)?.[0];
    expect(terminal).toContain('viewBox="0 0 16 16"');
    expect(terminal).toContain('stroke-width="1.5"');
    expect(terminal).toContain('d="M3 4l4 4-4 4 M9 12h4"');
    expect(html).not.toContain('id="i-clear"');
  });

  it("keeps delete controls on the shared decorative sprite", () => {
    const html = renderToStaticMarkup(<Icon name="bin" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('href="#i-bin"');
  });
});

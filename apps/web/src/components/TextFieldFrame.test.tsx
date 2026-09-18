import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

describe("TextFieldFrame", () => {
  it("retains span props and wraps its native field", () => {
    const html = renderToStaticMarkup(
      <TextFieldFrame data-surface="find">
        <input aria-label="Find" />
      </TextFieldFrame>,
    );
    expect(html).toContain('class="text-field-frame"');
    expect(html).toContain('data-surface="find"');
    expect(html).toContain('<input aria-label="Find"/>');
  });
});

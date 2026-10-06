import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbNotice } from "./OrbNotice.tsx";

describe("OrbNotice", () => {
  it.each([false, true])("renders gutter-free diagnostics with error=%s", (error) => {
    const html = renderToStaticMarkup(
      <OrbNotice error={error}>OpenAI device login required. &lt;challenge&gt;</OrbNotice>,
    );

    expect(html).toContain('class="rec rec-sys orb-notice"');
    expect(html).not.toContain("rec-px");
    expect(html).not.toContain("···");
    expect(html).toContain(error ? "rec-bd notice notice-error" : 'rec-bd notice"');
    expect(html).toContain("OpenAI device login required. &lt;challenge&gt;");
  });
});

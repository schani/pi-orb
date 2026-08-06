import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer.tsx";

const noop = () => {};

function render(mode: "message" | "shell" | "excluded_shell", withImage = false): string {
  return renderToStaticMarkup(
    <Composer
      text="npm test"
      mode={mode}
      onValueChange={noop}
      images={withImage ? [{ id: "image-1", mediaType: "image/png", data: "aGVsbG8=" }] : []}
      onImageAdd={noop}
      onImageRemove={noop}
      canSend
      onSend={noop}
      canAbort={false}
      onAbort={noop}
      pending={false}
      onShellAttachmentBlocked={noop}
    />,
  );
}

describe("Composer shell presentation", () => {
  it("shows exact mode labels and uses monospace only for shell modes", () => {
    expect(render("message")).toContain(
      '<div class="composer-mode" aria-live="polite">message</div>',
    );
    expect(render("message")).not.toContain("composer-input-shell");
    expect(render("shell")).toContain("composer-input composer-input-shell");
    expect(render("shell")).toContain('aria-live="polite">shell</div>');
    expect(render("excluded_shell")).toContain('aria-live="polite">excluded shell</div>');
  });

  it("prevents shell submission while preserving an image attachment", () => {
    const html = render("shell", true);
    expect(html).toContain('alt="pasted attachment"');
    expect(html).toContain('title="remove image attachments to run"');
    expect(html).toMatch(/<button[^>]*class="composer-send"[^>]*disabled=""/);
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });
});

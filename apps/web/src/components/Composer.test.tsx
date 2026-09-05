import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer.tsx";

const noop = () => {};

function render(
  mode: "message" | "shell" | "excluded_shell",
  withImage = false,
  canSend = true,
): string {
  return renderToStaticMarkup(
    <Composer
      text="npm test"
      mode={mode}
      onValueChange={noop}
      images={withImage ? [{ id: "image-1", mediaType: "image/png", data: "aGVsbG8=" }] : []}
      onImageAdd={noop}
      onImageRemove={noop}
      canSend={canSend}
      onSend={noop}
      canAbort={false}
      onAbort={noop}
      onShellAttachmentBlocked={noop}
    />,
  );
}

describe("Composer shell presentation", () => {
  it("starts with four lines", () => {
    expect(render("message")).toMatch(/<textarea[^>]*rows="4"/);
  });

  it("carries the mode in the prefix column", () => {
    expect(render("message")).toContain('<span class="composer-prefix">&gt;</span>');
    expect(render("shell")).toContain('<span class="composer-prefix">!</span>');
    expect(render("excluded_shell")).toContain('<span class="composer-prefix">!!</span>');
  });

  it("keeps exact mode labels in a visually hidden live region", () => {
    expect(render("message")).toContain(
      '<div class="composer-mode visually-hidden" aria-live="polite">message</div>',
    );
    expect(render("shell")).toContain('aria-live="polite">shell</div>');
    expect(render("excluded_shell")).toContain('aria-live="polite">excluded shell</div>');
  });

  it("keeps an image attachment and the shell prefix when submission is blocked", () => {
    const html = render("shell", true);
    expect(html).toContain('alt="pasted attachment"');
    expect(html).toContain('aria-live="polite">shell</div>');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it("keeps the textarea editable while sending is unavailable so the next message can be drafted", () => {
    const html = render("message", false, false);
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it("offers no send control: ⌘⏎ is the only send gesture", () => {
    expect(render("message")).not.toContain("<button");
  });
});

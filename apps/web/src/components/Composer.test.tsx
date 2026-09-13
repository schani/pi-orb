import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer.tsx";

const noop = () => {};

function render(
  mode: "message" | "shell" | "excluded_shell",
  withImage = false,
  canSend = true,
  canAbort = false,
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
      canAbort={canAbort}
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

  it("uses the shared X icon for abort with an accessible action name", () => {
    const html = render("message", false, true, true);
    expect(html).toContain('class="icon-button composer-abort"');
    expect(html).toContain('aria-label="abort"');
    expect(html).toContain('title="abort"');
    expect(html).toContain('href="#i-x"');
    expect(html).not.toContain(">abort</button>");
    expect(render("message")).not.toContain('class="icon-button composer-abort"');
  });

  it("places touch send in the phone-only side rail, retaining four desktop lines", () => {
    const html = render("message");
    expect(html).toContain('class="composer-phone-rail"');
    expect(html).toContain('aria-label="Send message"');
    expect(html).toContain('href="#i-fold"');
    expect(html).toContain('href="#i-send"');
    expect(html).toContain('data-expanded="false"');
    expect(html).toMatch(/<textarea[^>]*rows="4"/);
  });

  it("disables phone send under the same admission and attachment rules", () => {
    expect(render("message", false, false)).toMatch(/aria-label="Send message"[^>]*disabled=""/);
    expect(render("shell", true)).toMatch(/aria-label="Run command"[^>]*disabled=""/);
    expect(render("shell")).not.toMatch(/aria-label="Run command"[^>]*disabled=""/);
  });
});

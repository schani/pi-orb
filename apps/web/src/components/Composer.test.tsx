import type { ReactElement, TextareaHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.tsx";

let input: TextareaHTMLAttributes<HTMLTextAreaElement>;
vi.mock("./TextFieldFrame.tsx", () => ({
  TextFieldFrame: ({ children }: { children: ReactElement }) => {
    input = children.props as TextareaHTMLAttributes<HTMLTextAreaElement>;
    return children;
  },
}));

const noop = () => {};

function render(
  mode: "message" | "command",
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
    />,
  );
}

describe("Composer", () => {
  it("renders a native textarea without a caret overlay or mirror", () => {
    const markup = render("message");
    expect(markup).not.toContain("composer-caret");
    expect(markup).not.toContain("data-block-caret");
  });

  it.each(["!", "Backspace"])("does not consume %s at the start of a message", (key) => {
    render("message");
    const preventDefault = vi.fn();
    input.onKeyDown?.({
      key,
      nativeEvent: { isComposing: false },
      currentTarget: { selectionStart: 0, selectionEnd: 0 },
      preventDefault,
    } as unknown as Parameters<NonNullable<typeof input.onKeyDown>>[0]);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["whole command overwrite", "effort ", "/effort ", 8, "insertText", "/effort ", "effort "],
    ["pasted slash", "effort ", "/effort ", 1, "insertFromPaste", "/", "effort "],
    ["slash replacing a selection", "npm test", "/ test", 1, "insertText", "/", " test"],
  ])("handles %s without keydown", (_, draft, value, caret, inputType, data, expected) => {
    const onValueChange = vi.fn();
    renderToStaticMarkup(
      <Composer
        text={draft}
        mode="message"
        onValueChange={onValueChange}
        images={[]}
        onImageAdd={noop}
        onImageRemove={noop}
        canSend
        onSend={noop}
        canAbort={false}
        onAbort={noop}
      />,
    );
    input.onChange?.({
      target: { value, selectionStart: caret, selectionEnd: caret },
      nativeEvent: { inputType, data, isComposing: false },
    } as unknown as Parameters<NonNullable<typeof input.onChange>>[0]);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(expected, "command");
  });

  it("starts with four lines without visible prompt text", () => {
    const message = render("message");
    expect(message).toMatch(/<textarea[^>]*aria-label="Message the orb"[^>]*rows="4"/);
    expect(message).not.toContain("placeholder=");
    expect(message).not.toContain("Message the orb…");
  });

  it("carries the mode in the prefix column", () => {
    expect(render("message")).toContain('<span class="composer-prefix">&gt;</span>');
    expect(render("command")).toContain('<span class="composer-prefix">/</span>');
  });

  it("keeps exact mode labels in a visually hidden live region", () => {
    expect(render("message")).toContain(
      '<div class="composer-mode visually-hidden" aria-live="polite">message</div>',
    );
    expect(render("command")).toContain('aria-live="polite">command</div>');
  });

  it("keeps image attachments with an editable message", () => {
    const html = render("message", true);
    expect(html).toContain('alt="pasted attachment"');
    expect(html).toContain('aria-live="polite">message</div>');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it("shows an inset drop hint even when sending is unavailable", () => {
    const html = renderToStaticMarkup(
      <Composer
        text="draft"
        mode="message"
        onValueChange={noop}
        images={[]}
        onImageAdd={noop}
        onImageRemove={noop}
        canSend={false}
        onSend={noop}
        canAbort={false}
        onAbort={noop}
        dropLabel="Uploads need a running orb."
      />,
    );
    expect(html).toContain('class="orb-drop-inset"');
    expect(html).toContain("Uploads need a running orb.");
    expect(html).toContain('rows="4">draft</textarea>');
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
    expect(render("message", true)).not.toMatch(/aria-label="Send message"[^>]*disabled=""/);
    expect(render("command")).toMatch(/aria-label="Send message"[^>]*disabled=""/);
  });
});

it("runs /goal with an objective without invoking settings or sending a message", () => {
  const onGoalCommand = vi.fn();
  const onSend = vi.fn();
  const onSettingsChange = vi.fn();
  const markup = renderToStaticMarkup(
    <Composer
      text="goal Ship the fix"
      mode="command"
      onValueChange={noop}
      images={[]}
      onImageAdd={noop}
      onImageRemove={noop}
      canSend
      onSend={onSend}
      canAbort
      onAbort={noop}
      onSettingsChange={onSettingsChange}
      onGoalCommand={onGoalCommand}
    />,
  );
  expect(markup).toContain(">goal</span>");
  expect(markup).toContain('aria-label="abort"');
  input.onKeyDown?.({
    key: "Enter",
    nativeEvent: { isComposing: false },
    preventDefault: noop,
  } as unknown as Parameters<NonNullable<typeof input.onKeyDown>>[0]);
  expect(onGoalCommand).toHaveBeenCalledWith("Ship the fix");
  expect(onSend).not.toHaveBeenCalled();
  expect(onSettingsChange).not.toHaveBeenCalled();
});

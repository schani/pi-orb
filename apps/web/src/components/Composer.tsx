import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ComposerCaret } from "./ComposerCaret.tsx";
import {
  type ComposerMode,
  composerModeGlyph,
  composerModeLabel,
  enterShellMode,
  leaveShellMode,
  normalizeComposerChange,
} from "./composer-mode.ts";
import { OrbLinkPicker } from "./OrbLinkPicker.tsx";
import { isSendShortcut } from "./send-shortcut.ts";

export interface ComposerImage {
  id: string;
  /** e.g. "image/png". */
  mediaType: string;
  /** Base64 payload without a data-URL prefix. */
  data: string;
}

interface ComposerProps {
  text: string;
  mode: ComposerMode;
  onValueChange: (text: string, mode: ComposerMode) => void;
  /** Images pasted into the composer, awaiting send. */
  images: ComposerImage[];
  onImageAdd: (mediaType: string, data: string) => void;
  onImageRemove: (id: string) => void;
  /** Connected, idle, and no request in flight. */
  canSend: boolean;
  onSend: () => void;
  /** An operation is running and can be aborted. */
  canAbort: boolean;
  onAbort: () => void;
  /** Shell submission was attempted while an image remains attached. */
  onShellAttachmentBlocked: () => void;
}

export function Composer({
  text,
  mode,
  onValueChange,
  images,
  onImageAdd,
  onImageRemove,
  canSend,
  onSend,
  canAbort,
  onAbort,
  onShellAttachmentBlocked,
}: ComposerProps) {
  const isShell = mode !== "message";
  const shellBlockedByAttachment = isShell && images.length > 0;
  const hasInput = isShell ? text.trim() !== "" : text.trim() !== "" || images.length > 0;
  const sendEnabled = canSend && hasInput && !shellBlockedByAttachment;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mentionOffset, setMentionOffset] = useState<number | null>(null);
  const restoreCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (mentionOffset !== null || restoreCaret.current === null) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.setSelectionRange(restoreCaret.current, restoreCaret.current);
    restoreCaret.current = null;
  });

  const closePicker = (href?: string) => {
    if (mentionOffset === null) return;
    let caret = mentionOffset + 1;
    if (href !== undefined && mode === "message" && text[mentionOffset] === "@") {
      const url = `${window.location.href.split("#")[0]}${href}`;
      onValueChange(text.slice(0, mentionOffset) + url + text.slice(mentionOffset + 1), mode);
      caret = mentionOffset + url.length;
    }
    restoreCaret.current = caret;
    setMentionOffset(null);
  };

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = () => {
    onSend();
    inputRef.current?.focus();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const comma = dataUrl.indexOf(",");
        if (comma !== -1) onImageAdd(file.type, dataUrl.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="composer">
      {mentionOffset !== null && (
        <OrbLinkPicker onSelect={closePicker} onClose={() => closePicker()} />
      )}
      {images.length > 0 && (
        <div className="composer-attachments">
          {images.map((image) => (
            <span className="composer-attachment" key={image.id}>
              <img src={`data:${image.mediaType};base64,${image.data}`} alt="pasted attachment" />
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label="remove image"
                onClick={() => onImageRemove(image.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-line">
        <span className="composer-prefix">{composerModeGlyph(mode)}</span>
        <div className="composer-editor">
          <textarea
            ref={inputRef}
            className="composer-input"
            value={text}
            onChange={(event) => {
              const normalized = normalizeComposerChange(mode, event.target.value);
              onValueChange(normalized.text, normalized.mode);
              const input = event.nativeEvent as InputEvent;
              if (
                mode === "message" &&
                normalized.mode === "message" &&
                input.inputType === "insertText" &&
                input.data === "@" &&
                !input.isComposing
              ) {
                setMentionOffset(event.target.selectionStart - 1);
              }
            }}
            onPaste={handlePaste}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              const atStart = event.currentTarget.selectionStart === 0;
              const collapsed =
                event.currentTarget.selectionStart === event.currentTarget.selectionEnd;
              if (
                event.key === "!" &&
                atStart &&
                collapsed &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
              ) {
                const nextMode = enterShellMode(mode);
                if (nextMode !== null) {
                  event.preventDefault();
                  onValueChange(text, nextMode);
                  return;
                }
              }
              if (event.key === "Backspace" && atStart && collapsed) {
                const nextMode = leaveShellMode(mode);
                if (nextMode !== null) {
                  event.preventDefault();
                  onValueChange(text, nextMode);
                  return;
                }
              }
              if (isSendShortcut(event)) {
                if (shellBlockedByAttachment) {
                  event.preventDefault();
                  onShellAttachmentBlocked();
                } else if (sendEnabled) {
                  event.preventDefault();
                  submit();
                }
              }
            }}
            placeholder={isShell ? "Run a shell command… (⌘⏎ to run)" : "Message the orb…"}
            rows={4}
          />
          <ComposerCaret inputRef={inputRef} text={text} />
        </div>
        {canAbort && (
          <button type="button" className="text-action" onClick={onAbort}>
            abort
          </button>
        )}
      </div>
      <div className="composer-mode visually-hidden" aria-live="polite">
        {composerModeLabel(mode)}
      </div>
    </div>
  );
}

import type { AgentSettingsEvent, SettingsAction } from "@pi-orb/protocol";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePhoneLayout } from "../lib/use-phone-layout.ts";
import { ComposerCaret } from "./ComposerCaret.tsx";
import { type CommandOption, commandOptions } from "./command-options.ts";
import {
  type ComposerMode,
  composerModeGlyph,
  composerModeLabel,
  enterShellMode,
  leaveShellMode,
  normalizeComposerChange,
} from "./composer-mode.ts";
import { Icon } from "./Icons.tsx";
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
  /** Phone-only operation feedback, beside the initiating control. */
  feedback?: string;
  settings?: AgentSettingsEvent | null;
  settingsDisabled?: boolean;
  settingsPending?: boolean;
  onSettingsChange?: (action: SettingsAction) => void;
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
  feedback,
  settings = null,
  settingsDisabled = true,
  settingsPending = false,
  onSettingsChange,
}: ComposerProps) {
  const isCommand = mode === "command";
  const isShell = mode === "shell" || mode === "excluded_shell";
  const [commandIndex, setCommandIndex] = useState(0);
  const choices = commandOptions(text, settings);
  const selectedCommand = Math.min(commandIndex, Math.max(0, choices.length - 1));
  const chooseCommand = (choice: CommandOption | undefined) => {
    if (choice?.text !== undefined) {
      onValueChange(choice.text, "command");
      setCommandIndex(0);
    } else if (choice?.action && !settingsDisabled) onSettingsChange?.(choice.action);
  };
  const shellBlockedByAttachment = isShell && images.length > 0;
  const hasInput = isShell ? text.trim() !== "" : text.trim() !== "" || images.length > 0;
  const sendEnabled = !isCommand && canSend && hasInput && !shellBlockedByAttachment;
  const phone = usePhoneLayout();
  const [expanded, setExpanded] = useState(false);
  const padRef = useRef<HTMLButtonElement>(null);
  const awaitingClear = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commandPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isCommand || (phone && !expanded)) return;
    const dismiss = () => {
      setCommandIndex(0);
      onValueChange("", "message");
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        commandPickerRef.current?.contains(event.target) ||
        inputRef.current?.contains(event.target)
      )
        return;
      dismiss();
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      inputRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [isCommand, phone, expanded, onValueChange]);
  const [mentionOffset, setMentionOffset] = useState<number | null>(null);
  const restoreCaret = useRef<number | null>(null);
  useEffect(() => {
    if (mode === "command") {
      if (phone) setExpanded(true);
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [mode, phone]);

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
    if (!phone) inputRef.current?.focus({ preventScroll: true });
  }, [phone]);

  useLayoutEffect(() => {
    if (phone && expanded) inputRef.current?.focus({ preventScroll: true });
  }, [phone, expanded]);

  useEffect(() => {
    if (!awaitingClear.current || hasInput) return;
    awaitingClear.current = false;
    if (phone) {
      inputRef.current?.blur();
      setExpanded(false);
    }
  }, [hasInput, phone]);

  const fold = () => {
    setMentionOffset(null);
    inputRef.current?.blur();
    setExpanded(false);
    padRef.current?.focus({ preventScroll: true });
  };

  const submit = () => {
    awaitingClear.current = true;
    onSend();
    if (!phone) inputRef.current?.focus();
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
    <div className="composer" data-expanded={expanded} data-settings-pending={settingsPending}>
      {(feedback || shellBlockedByAttachment) && (
        <div className="composer-phone-feedback" role="status">
          {feedback || "Remove image attachments before running a shell command."}
        </div>
      )}
      <div className="composer-phone-pad">
        <button
          ref={padRef}
          type="button"
          className="composer-open"
          aria-label="Write message"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          <span className="composer-prefix">{composerModeGlyph(mode)}</span>
          <span className="composer-draft-preview">
            {text ||
              (images.length > 0
                ? `${images.length} image attachment${images.length === 1 ? "" : "s"}`
                : "")}
          </span>
        </button>
        {canAbort && (
          <button
            type="button"
            className="icon-button"
            aria-label="abort"
            title="abort"
            onClick={onAbort}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      {isCommand && (!phone || expanded) && (
        <div
          ref={commandPickerRef}
          className="command-picker"
          role="listbox"
          aria-label="Commands"
          id="command-choices"
        >
          {choices.map((choice, index) => (
            <button
              type="button"
              role="option"
              id={`command-choice-${index}`}
              aria-selected={index === selectedCommand}
              key={choice.label}
              className={index === selectedCommand ? "selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(choice)}
              disabled={choice.action !== undefined && settingsDisabled}
            >
              <span>{choice.label}</span>
              <span aria-hidden="true">{choice.current ? "✓" : choice.text ? "→" : ""}</span>
            </button>
          ))}
          {choices.length === 0 && (
            <div className="command-empty">
              {settings === null
                ? "Settings unavailable — connect to a running orb."
                : "No matching command or value."}
            </div>
          )}
          {settings !== null && settingsDisabled && (
            <div className="command-empty">Wait for the current operation to finish.</div>
          )}
        </div>
      )}
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
              awaitingClear.current = false;
              setCommandIndex(0);
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
              if (event.nativeEvent.isComposing) return;
              if (isCommand) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setCommandIndex(
                    choices.length
                      ? (selectedCommand + (event.key === "ArrowDown" ? 1 : -1) + choices.length) %
                          choices.length
                      : 0,
                  );
                  return;
                }
                if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
                  event.preventDefault();
                  chooseCommand(choices[selectedCommand]);
                  return;
                }
              }
              if (
                event.key === "/" &&
                mode === "message" &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
              ) {
                event.preventDefault();
                onValueChange(text, "command");
                setCommandIndex(0);
                return;
              }
              if (phone && event.key === "Escape") {
                event.preventDefault();
                fold();
                return;
              }
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
              if (
                event.key === "Backspace" &&
                atStart &&
                collapsed &&
                (!isCommand || text === "")
              ) {
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
            aria-label={isShell ? "Run a shell command" : "Message the orb"}
            aria-controls={isCommand ? "command-choices" : undefined}
            aria-activedescendant={
              isCommand && choices.length ? `command-choice-${selectedCommand}` : undefined
            }
            rows={4}
          />
          <ComposerCaret inputRef={inputRef} text={text} />
        </div>
        <div className="composer-phone-rail">
          <button
            type="button"
            className="icon-button"
            aria-label="Fold editor"
            title="fold"
            onClick={fold}
          >
            <Icon name="fold" />
          </button>
          <button
            type="button"
            className="icon-button composer-send"
            aria-label={isShell ? "Run command" : "Send message"}
            title={isShell ? "run" : "send"}
            disabled={!sendEnabled}
            onClick={submit}
          >
            <Icon name="send" />
          </button>
        </div>
        {canAbort && (
          <button
            type="button"
            className="icon-button composer-abort"
            aria-label="abort"
            title="abort"
            onClick={onAbort}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      <div className="composer-mode visually-hidden" aria-live="polite">
        {composerModeLabel(mode)}
      </div>
    </div>
  );
}

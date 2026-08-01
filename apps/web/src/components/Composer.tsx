import type { ClipboardEvent, KeyboardEvent } from "react";
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
  onTextChange: (text: string) => void;
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
  /** A request is awaiting its result frame. */
  pending: boolean;
}

export function Composer({
  text,
  onTextChange,
  images,
  onImageAdd,
  onImageRemove,
  canSend,
  onSend,
  canAbort,
  onAbort,
  pending,
}: ComposerProps) {
  const sendEnabled = canSend && (text.trim() !== "" || images.length > 0);

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
      <div className="composer-row">
        <textarea
          className="composer-input"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (isSendShortcut(event) && sendEnabled) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Message the agent… (paste images directly, ⌘⏎ to send)"
          rows={3}
          disabled={!canSend}
        />
        <button
          type="button"
          className="composer-send"
          aria-label="send"
          title="send (⌘⏎)"
          onClick={onSend}
          disabled={!sendEnabled}
        >
          {pending ? "…" : "↑"}
        </button>
      </div>
      {canAbort && (
        <div className="composer-actions">
          <button type="button" className="danger" onClick={onAbort}>
            abort
          </button>
        </div>
      )}
    </div>
  );
}

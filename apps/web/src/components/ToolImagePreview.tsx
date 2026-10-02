import { useRef, useState } from "react";

interface ToolImagePreviewProps {
  src?: string;
  toolName: string;
}

export function ToolImagePreview({ src, toolName }: ToolImagePreviewProps) {
  const source = src ?? null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = `Image returned by ${toolName}`;

  if (source === null) {
    return (
      <div className="tool-image-state" role="status">
        image unavailable
      </div>
    );
  }
  if (failedSource === source) {
    return (
      <div className="tool-image-state tool-image-state-failed" role="status">
        image failed to load
      </div>
    );
  }

  return (
    <div className="tool-image-preview">
      <button
        ref={trigger}
        className="tool-image-trigger"
        type="button"
        aria-label={`Enlarge image returned by ${toolName}`}
        onClick={() => dialog.current?.showModal()}
      >
        <img
          className="tool-image-thumbnail"
          src={source}
          alt={label}
          onError={() => setFailedSource(source)}
        />
      </button>
      <dialog
        ref={dialog}
        className="tool-image-dialog"
        aria-label={label}
        onClose={() => trigger.current?.focus()}
      >
        <button
          className="tool-image-dialog-close"
          type="button"
          aria-label="Close image preview"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <img
          className="tool-image-full"
          src={source}
          alt={label}
          onError={() => setFailedSource(source)}
        />
      </dialog>
    </div>
  );
}

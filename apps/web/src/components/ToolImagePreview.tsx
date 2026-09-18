import type { ContentBlock } from "@pi-orb/protocol";
import { useRef, useState } from "react";

type ImageBlock = Extract<ContentBlock, { type: "image" }>;

interface ToolImagePreviewProps {
  block: ImageBlock;
  toolName: string;
}

function imageSource(block: ImageBlock): string | null {
  if (block.data !== undefined) {
    return `data:${block.mediaType ?? "image/png"};base64,${block.data}`;
  }
  return block.url ?? null;
}

export function ToolImagePreview({ block, toolName }: ToolImagePreviewProps) {
  const source = imageSource(block);
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

import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { Icon } from "./Icons.tsx";

type CopyState = "idle" | "copied" | "failed";

export function ResponseMarkdown({
  markdown,
  copySource,
}: {
  markdown: string;
  copySource: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    const result = await copyToClipboard(copySource);
    setCopyState(result.isOk() ? "copied" : "failed");
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = result.isOk() ? setTimeout(() => setCopyState("idle"), 1600) : null;
  };
  const label =
    copyState === "copied"
      ? "Copied response Markdown"
      : copyState === "failed"
        ? "Copy response Markdown failed"
        : "Copy response Markdown";

  return (
    <div className="response-markdown">
      <ChatMarkdown>{markdown}</ChatMarkdown>
      <button
        type="button"
        className="icon-button response-copy"
        data-state={copyState}
        aria-label={label}
        title={label}
        onClick={copy}
      >
        <Icon name="copy" />
      </button>
      <span
        className={`response-copy-status${copyState === "copied" ? " visually-hidden" : ""}`}
        role="status"
        aria-live="polite"
      >
        {copyState === "copied" ? "copied" : copyState === "failed" ? "copy failed" : ""}
      </span>
    </div>
  );
}

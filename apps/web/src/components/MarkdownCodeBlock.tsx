import {
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";

type CopyState = "idle" | "copied" | "failed";
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & { node?: unknown };

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

/** Removes react-markdown's fence-closing newline while preserving source whitespace. */
export function markdownCodeText(children: ReactNode): string {
  return nodeText(children).replace(/\n$/, "");
}

export function MarkdownCodeBlock({ children, node: _node, ...props }: MarkdownPreProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    const result = await copyToClipboard(markdownCodeText(children));
    setCopyState(result.isOk() ? "copied" : "failed");
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1600);
  };

  const label =
    copyState === "copied"
      ? "Copied to clipboard"
      : copyState === "failed"
        ? "Copy failed—try again"
        : "Copy code to clipboard";

  return (
    <div className="markdown-code-block">
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className="markdown-code-copy"
        data-state={copyState}
        aria-label={label}
        title={label}
        aria-live="polite"
        onClick={copy}
      >
        {copyState === "copied" ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3 8.5 3.1 3.1L13.2 4.5" />
          </svg>
        ) : copyState === "failed" ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v6M8 12.5v.1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
            <path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" />
          </svg>
        )}
      </button>
    </div>
  );
}

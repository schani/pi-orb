import {
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";
import { Icon } from "./Icons.tsx";

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

  const copyButton = (
    <button
      type="button"
      className="icon-button markdown-code-copy"
      data-state={copyState}
      aria-label={label}
      title={label}
      aria-live="polite"
      onClick={copy}
    >
      <Icon name="copy" />
    </button>
  );

  return (
    <div className="markdown-code-block">
      {copyButton}
      <pre {...props}>{children}</pre>
    </div>
  );
}

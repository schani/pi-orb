import {
  type ComponentPropsWithoutRef,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ExtraProps } from "react-markdown";
import { copyToClipboard } from "../lib/copy-to-clipboard.ts";
import { Icon } from "./Icons.tsx";
import { MermaidDiagram } from "./MermaidDiagram.tsx";

type CopyState = "idle" | "copied" | "failed";
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;

/** The Markdown being rendered, so a fence can tell whether its closing fence has arrived. */
export const MarkdownSource = createContext("");

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

function isMermaid(children: ReactNode): boolean {
  return (
    isValidElement<{ className?: string }>(children) &&
    children.props.className === "language-mermaid"
  );
}

/** A streaming fence has no closing fence yet; its source runs to the end of the Markdown. */
function isClosedFence(raw: string): boolean {
  return /\n[\s>]*(`{3,}|~{3,})\s*$/.test(raw);
}

export function MarkdownCodeBlock({ children, node, ...props }: MarkdownPreProps) {
  const markdown = useContext(MarkdownSource);
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

  const { start, end } = node?.position ?? {};
  if (
    isMermaid(children) &&
    isClosedFence(markdown.slice(start?.offset ?? 0, end?.offset ?? markdown.length))
  )
    return <MermaidDiagram source={markdownCodeText(children)} copyButton={copyButton} />;

  return (
    <div className="markdown-code-block">
      {copyButton}
      <pre {...props}>{children}</pre>
    </div>
  );
}

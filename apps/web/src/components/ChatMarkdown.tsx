import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatLink } from "./ChatText.tsx";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.tsx";

function MarkdownTable({ children }: ComponentPropsWithoutRef<"table">) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must support keyboard scrolling.
    <section className="markdown-table-scroll" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </section>
  );
}

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ChatLink, pre: MarkdownCodeBlock, table: MarkdownTable }}
      >
        {children}
      </Markdown>
    </div>
  );
}

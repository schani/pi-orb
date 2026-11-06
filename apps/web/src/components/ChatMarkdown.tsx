import { type ComponentPropsWithoutRef, useContext } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveOrbFileUrl } from "../lib/orb-file-url.ts";
import { ChatLink } from "./ChatText.tsx";
import { MarkdownCodeBlock, MarkdownSource } from "./MarkdownCodeBlock.tsx";
import { OrbFilesBaseUrl } from "./OrbFilesBaseUrl.ts";

function MarkdownTable({ children }: ComponentPropsWithoutRef<"table">) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must support keyboard scrolling.
    <section className="markdown-table-scroll" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </section>
  );
}

export function ChatMarkdown({ children }: { children: string }) {
  const filesBaseUrl = useContext(OrbFilesBaseUrl);
  return (
    <div className="chat-markdown">
      <MarkdownSource.Provider value={children}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url, key, node) =>
            node.tagName === "a" && key === "href" && /^orb:/i.test(url)
              ? resolveOrbFileUrl(url, filesBaseUrl).unwrapOr(undefined)
              : defaultUrlTransform(url)
          }
          components={{ a: ChatLink, pre: MarkdownCodeBlock, table: MarkdownTable }}
        >
          {children}
        </Markdown>
      </MarkdownSource.Provider>
    </div>
  );
}

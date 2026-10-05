import type { PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString as markdownText } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { capHeadline } from "./headline.ts";

/** Summary metadata only; the complete Markdown remains in the on-demand body. */
export function reasoningHeadline(markdown: string, redacted = false): string {
  if (redacted) return "";
  const titles: string[] = [];
  const add = (node: RootContent) => {
    const title = markdownText(node, { includeHtml: false }).replace(/\s+/g, " ").trim();
    if (title !== "") titles.push(title);
  };
  const visit = (node: RootContent) => {
    if (node.type === "heading") add(node);
    else if (node.type === "paragraph") {
      // Soft breaks share a paragraph: a title must occupy one physical line,
      // not merely be the paragraph's only child or a multiline strong span.
      let line: PhrasingContent[] = [];
      const flush = () => {
        const visible = line.filter((child) => child.type !== "text" || child.value.trim() !== "");
        const only = visible[0];
        if (
          visible.length === 1 &&
          only?.type === "strong" &&
          only.position?.start.line === only.position?.end.line
        )
          add(only);
        line = [];
      };
      for (const child of node.children) {
        if (child.type === "text") {
          const source = markdown.slice(child.position?.start.offset, child.position?.end.offset);
          const parts = source.split(/\r\n|\r|\n/);
          parts.forEach((value, index) => {
            if (index > 0) flush();
            line.push({ type: "text", value });
          });
        } else if (child.type === "break") {
          flush();
        } else line.push(child);
      }
      flush();
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  for (const node of fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children)
    visit(node);
  return capHeadline(titles.join(" · "));
}

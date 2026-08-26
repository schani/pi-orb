import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatLink } from "./ChatText.tsx";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock.tsx";

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ChatLink, pre: MarkdownCodeBlock }}>
        {children}
      </Markdown>
    </div>
  );
}

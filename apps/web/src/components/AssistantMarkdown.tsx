import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatLink } from "./ChatText.tsx";

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ChatLink }}>
        {children}
      </Markdown>
    </div>
  );
}

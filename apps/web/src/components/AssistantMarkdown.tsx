import Markdown from "react-markdown";

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown>{children}</Markdown>
    </div>
  );
}

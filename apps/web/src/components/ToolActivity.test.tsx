import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "./ToolActivity.tsx";

describe("generic tool disclosure", () => {
  it.each(["subagent", "get_subagent_result", "mcp_call"])(
    "shows %s input and output behind just the category disclosure",
    (name) => {
      const html = renderToStaticMarkup(
        <ToolActivity
          persisted={[
            {
              call: {
                type: "tool_call",
                callId: "call-one",
                name,
                arguments: { task: "Inspect services" },
              },
              result: {
                type: "tool_result",
                callId: "call-one",
                content: [{ type: "text", text: "Four services found" }],
              },
            },
          ]}
        />,
      );
      expect(html.match(/<details\b/g)).toHaveLength(1);
      expect(html).toContain("Inspect services");
      expect(html).toContain("Four services found");
    },
  );
});

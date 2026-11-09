import { expect, it } from "vitest";
import { toLlmContent } from "./mcp-content.ts";

it("preserves MCP rendering for text, images, resources and placeholders", () => {
  expect(
    toLlmContent({
      content: [
        { type: "text", text: "plain", annotations: { priority: 1 } },
        { type: "image", data: "image-data", mimeType: "image/png" },
        { type: "audio", data: "audio-data", mimeType: "audio/wav" },
        { type: "resource_link", name: "link", uri: "doc:link" },
        { type: "resource", resource: { uri: "doc:text", text: "embedded" } },
        {
          type: "resource",
          resource: { uri: "doc:image", blob: "blob-data", mimeType: "image/jpeg" },
        },
        {
          type: "resource",
          resource: { uri: "doc:binary", blob: "omitted", mimeType: "application/pdf" },
        },
        { type: "resource", resource: { uri: "doc:unknown", blob: "omitted" } },
      ],
    }),
  ).toEqual([
    { type: "text", text: "plain" },
    { type: "image", data: "image-data", mimeType: "image/png" },
    { type: "text", text: "[audio audio/wav omitted]" },
    { type: "text", text: "link: doc:link" },
    { type: "text", text: "embedded" },
    { type: "image", data: "blob-data", mimeType: "image/jpeg" },
    { type: "text", text: "[binary resource doc:binary (application/pdf) omitted]" },
    { type: "text", text: "[binary resource doc:unknown (unknown type) omitted]" },
  ]);
});

it.each([{ n: 7 }, [1, null, "value"], null].map((structuredContent) => ({ structuredContent })))(
  "renders unmirrored structured JSON %j",
  ({ structuredContent }) => {
    expect(toLlmContent({ content: [], structuredContent })).toEqual([
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
    ]);
    expect(
      toLlmContent({ content: [{ type: "text", text: "existing" }], structuredContent }),
    ).toEqual([{ type: "text", text: "existing" }]);
  },
);

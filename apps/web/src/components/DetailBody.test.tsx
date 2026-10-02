import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TranscriptCache } from "../lib/transcript-cache.ts";
import { imageIndex } from "./CommittedImage.tsx";
import { DetailContent } from "./DetailBody.tsx";

const context = {
  orbId: "orb",
  sessionId: "session",
  connected: false,
  operationId: null,
  cache: new TranscriptCache(),
  getOwner: () => null,
  livePending: new Map(),
  committedPending: new Map(),
  imagePending: new Map(),
};

it("keeps remote URLs browser-managed and local images loading on initial SSR", () => {
  const external = renderToStaticMarkup(
    <DetailContent
      context={context}
      recordId="r"
      detailKey="r:0"
      body={{ type: "image", url: "https://example.com/image.png" }}
    />,
  );
  expect(external).toContain('src="https://example.com/image.png"');
  const internal = renderToStaticMarkup(
    <DetailContent
      context={context}
      recordId="r"
      detailKey="r:0"
      body={{ type: "image", imageRef: "r:0:0" }}
    />,
  );
  expect(internal).toContain("Loading…");
  expect(internal).not.toContain("images/r/");
  expect(imageIndex("r:0", "r:0:4")).toBe(4);
  expect(imageIndex("r:0", "r:0:9007199254740992")).toBeNull();
});

it("preserves URL-backed tool image preview and omits base64", () => {
  const html = renderToStaticMarkup(
    <DetailContent
      context={context}
      recordId="r"
      detailKey="r:1"
      body={{
        type: "tool_result",
        content: [{ type: "image", url: "https://example.com/preview.png" }],
      }}
    />,
  );
  expect(html).toContain('src="https://example.com/preview.png"');
  expect(html).toContain("Enlarge image returned by tool result");
});

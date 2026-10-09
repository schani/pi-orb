import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

it("returns image bytes through the remote filesystem capability without rereading or using local fs", async () => {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=";
  let reads = 0;
  const api = {
    env: {
      absolutePath: async () => ({ ok: true, value: "/remote/image.png" }),
      exists: async () => ({ ok: true, value: true }),
      readBinaryFile: async (path: string) => {
        expect(path).toBe("/remote/image.png");
        reads++;
        return { ok: true, value: Buffer.from(image, "base64") };
      },
    },
  } as unknown as ToolExecutionApi;
  const tools = createDurableTools();
  try {
    const result = await tools.catalog.invoke(
      "read",
      { path: "@image.png" },
      api,
      BACKGROUND_CONTEXT,
    );
    expect(result._unsafeUnwrap().content).toEqual([
      { type: "image", data: image, mimeType: "image/png" },
    ]);
    expect(reads).toBe(1);
  } finally {
    await tools.close();
  }
});

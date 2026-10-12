import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

it("returns image bytes through the remote filesystem capability without rereading or using local fs", async () => {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=";
  const bytes = Buffer.from(image, "base64");
  let reads = 0;
  const api = {
    env: {
      absolutePath: async () => ({ ok: true, value: "/remote/image.png" }),
      exists: async () => ({ ok: true, value: true }),
      openBinaryReader: async (path: string) => {
        expect(path).toBe("/remote/image.png");
        return {
          ok: true,
          value: {
            info: async () => ({
              ok: true,
              value: { name: "image.png", path, kind: "file", size: bytes.length, mtimeMs: 1 },
            }),
            read: async (offset: number, length: number) => ({
              ok: true,
              value: new Uint8Array(bytes.subarray(offset, offset + length)),
            }),
            close: async () => undefined,
          },
        };
      },
      readBinaryFile: async (path: string) => {
        expect(path).toBe("/remote/image.png");
        reads++;
        return { ok: true, value: bytes };
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

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  createReadTool,
  type ImageProcessor,
  type PreparedImage,
} from "@earendil-works/pi-durable/tools";
import { errorResult } from "./catalog.ts";
import type { AgentToolFiles } from "./files.ts";

const rawImages: ImageProcessor = {
  async prepare(bytes, mimeType): Promise<PreparedImage | undefined> {
    if (
      bytes.byteLength > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)
    ) {
      return undefined;
    }
    return { data: Buffer.from(bytes).toString("base64"), mimeType };
  },
};

/** Native remote reads plus scoped immutable resources and private artifacts. */
export function imageReadTool(files: AgentToolFiles = {}): ToolRegistration {
  const read = createReadTool({ images: rawImages });
  return defineTool({
    ...read,
    description:
      "Read text or image files. Text is truncated to 2000 lines or 50 KiB; use offset/limit to continue. Scripts receive text or image blocks; show blocks with image().",
    execute: async (args, api, ctx) => {
      if (files.read) {
        const resource = await files.read(args, api, ctx);
        if (resource.isErr()) return errorResult(resource.error);
        if (resource.value !== undefined) return resource.value;
      }
      return read.execute(args, api, ctx);
    },
  });
}

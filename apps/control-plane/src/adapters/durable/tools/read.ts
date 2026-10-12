import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { errorResult } from "./catalog.ts";
import type { AgentToolFiles } from "./files.ts";

/** Preserve upstream path resolution and text behavior while retaining image bytes from the remote read. */
export function imageReadTool(files: AgentToolFiles = {}): ToolRegistration {
  const read = createReadTool();
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
      if (!api.env) return read.execute(args, api, ctx);
      // Upstream sniffs the type through a binary reader; keep its resolved path for the image bytes.
      let opened: string | undefined;
      const env = new Proxy(api.env, {
        get(target, key) {
          if (key === "openBinaryReader")
            return (
              path: string,
              options: { noFollow?: boolean } | undefined,
              context: Context,
            ) => {
              opened = path;
              return target.openBinaryReader(path, options, context);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await read.execute(args, { ...api, env }, ctx);
      if (!result.diagnostics?.some((d) => d.code === "unsupported_image") || opened === undefined)
        return result;
      const bytesRead = await api.env.readBinaryFile(opened, ctx);
      if (!bytesRead.ok)
        return { isError: true, content: [{ type: "text", text: bytesRead.error.message }] };
      const loaded = bytesRead.value;
      if (loaded.length > 20 * 1024 * 1024)
        return { isError: true, content: [{ type: "text", text: "Image exceeds 20 MiB" }] };
      const bytes = Buffer.from(loaded);
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216
          ? "image/jpeg"
          : bytes.subarray(0, 3).toString() === "GIF"
            ? "image/gif"
            : "image/webp";
      return { content: [{ type: "image", data: bytes.toString("base64"), mimeType }] };
    },
  });
}

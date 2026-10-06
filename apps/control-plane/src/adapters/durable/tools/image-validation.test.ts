import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";

const workerUrl = new URL("./bounded-worker.js", import.meta.url);
const memoryLimitBytes = 256 * 1024 * 1024;

it("preserves every byte of a full 20 MiB image callback through image() and the guarded tool", async () => {
  // Signature-valid fixture: qualifies byte preservation, not pixel decoding or provider acceptance.
  const png = Buffer.alloc(20 * 1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  const api = {
    conversationId: root.id,
    commit: root.commit.bind(root),
    callId: "full-image",
  } as ToolExecutionApi;
  const tool = codemodeTool(
    new CallableCatalog([
      defineTool({
        name: "picture",
        description: "picture",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
      }),
    ]),
    new Set(),
  );
  try {
    const result = await tool.execute(
      { code: 'image((await tools.picture({}))[0]); store("imagePassed",true);' },
      api,
      ctx,
    );
    expect(result.isError, JSON.stringify(result.content?.filter((b) => b.type === "text"))).toBe(
      false,
    );
    const images = result.content?.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images?.[0]).toEqual({ type: "image", data, mimeType: "image/png" });
    const saved = await tool.execute({ code: 'text(load("imagePassed"));' }, api, ctx);
    expect(saved.content).toContainEqual({ type: "text", text: "true" });
  } finally {
    await harness.close(ctx);
  }
});

it("preserves upstream base64, padding, media signature and input-shape validation", async () => {
  const png = "iVBORw0KGgo=";
  const accepted = [
    [png, "image/png"],
    ["iVBORw0KGgp=", "image/png"], // Upstream accepts noncanonical unused pad bits.
    ["iVBORw0KGg==", "image/png"],
    ["iVBORw0KGgoAAB==", "image/png"],
    ["iVBORw0KGgoA", "image/png"],
    ["iVBORw0KGgoAAA==", "image/png"],
    ["iVBORw0KGgoAAA/=", "image/png"],
    ["iVBORw0KGgoAAA+/", "image/png"],
    ["/9j/AA==", "image/jpeg"],
    ["R0lGODlh", "image/gif"],
    ["R0lGODdh", "image/gif"],
    ["UklGRgAAAABXRUJQ", "image/webp"],
  ];
  const invalidBase64 = [
    "",
    png.slice(0, -1),
    `${png}=`,
    "iVBORw0KGg===AAA",
    "iVBORw0KGg=A",
    "iVBORw0KGgo-",
    "iVBORw0KGgo_",
    "iVBORw0KGgo!",
    "iVBORw0KGgoé",
    "============",
  ];
  const invalidMedia = ["AAAAAAAAAAAA", "PHN2Zz48L3N2Zz4=", "/9j/9w=="];
  const sandbox = new CodemodeSandbox({ workerUrl, memoryLimitBytes });
  try {
    const result = await sandbox.execute(`
      for (const [data] of ${JSON.stringify(accepted)}) image({type:"image",data,mimeType:"wrong/type"});
      image({image_url:"data:image/jpeg;base64,${png}"});
      image("data:image/png;BASE64,iVBO Rw0K\\nGgo=");
      const bad = ${JSON.stringify(invalidBase64.map((data) => `data:image/png;base64,${data}`))};
      const media = ${JSON.stringify(invalidMedia.map((data) => `data:image/png;base64,${data}`))};
      for(const value of [...bad,...media,"https://example.com/a.png","data:image/png,${png}", {type:"text",data:"${png}"},{type:"image",data:""},null]) {
        try { image(value); text("accepted-invalid"); } catch(error) { text(error.message); }
      }
    `);
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    expect(result.output.filter((item) => item.type === "image")).toEqual([
      ...accepted.map(([data, mimeType]) => ({ type: "image", data, mimeType })),
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    const errors = result.output.filter((item) => item.type === "text").map((item) => item.text);
    expect(errors).toHaveLength(invalidBase64.length + invalidMedia.length + 5);
    expect(errors).not.toContain("accepted-invalid");
    expect(
      errors
        .slice(0, invalidBase64.length)
        .every((message) => message.includes("not valid base64")),
    ).toBe(true);
    expect(
      errors
        .slice(invalidBase64.length, invalidBase64.length + invalidMedia.length)
        .every((message) => message.includes("not a PNG, JPEG, GIF, or WebP")),
    ).toBe(true);
  } finally {
    await sandbox.close();
  }
});

it("rejects corruption at the full-size suffix without regexp OOM or store writes", async () => {
  const sandbox = new CodemodeSandbox({ workerUrl, memoryLimitBytes });
  try {
    const result = await sandbox.execute(`
      store("mustNotPersist",true);
      const data="iVBORw0KGgoA" + "A".repeat(27962028-13) + "!";
      image({type:"image",data,mimeType:"image/png"});
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toEqual([]);
    if (!result.ok) {
      expect(result.error.kind).toBe("script");
      expect(result.error.message).toContain("not valid base64");
    }
    expect(result).not.toHaveProperty("storeWrites");
  } finally {
    await sandbox.close();
  }
});

it("still rejects aggregate media overflow before forwarding and discards store writes", async () => {
  const sandbox = new CodemodeSandbox({ workerUrl, memoryLimitBytes });
  try {
    const result = await sandbox.execute(`
      store("mustNotPersist",true);
      const data="iVBORw0KGgoA" + "A".repeat(4*1024*1024-12);
      for(let i=0;i<9;i++) image({type:"image",data,mimeType:"image/png"});
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toHaveLength(8);
    expect(
      result.output.every((item) => item.type === "image" && item.data.length === 4 * 1024 * 1024),
    ).toBe(true);
    if (!result.ok) expect(result.error.message).toContain("32 MiB aggregate");
    expect(result).not.toHaveProperty("storeWrites");
  } finally {
    await sandbox.close();
  }
});

import { Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { imageReadTool } from "./read.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

const workerUrl = new URL("./bounded-worker.js", import.meta.url);
const memoryLimitBytes = 256 * 1024 * 1024;

it("preserves every byte of a full 20 MiB image callback through image() and the guarded tool", async () => {
  // Signature-valid fixture: qualifies byte preservation, not pixel decoding or provider acceptance.
  const png = Buffer.alloc(20 * 1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const fixture = await openCodemodeHarness(
    new CallableCatalog([
      defineTool({
        name: "picture",
        description: "picture",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "image", data, mimeType: "image/png" }] }),
      }),
    ]),
  );
  try {
    const result = await fixture.run(
      'image((await tools.picture({}))[0]); store("imagePassed",true);',
    );
    expect(result.isError, JSON.stringify(result.output?.filter((b) => b.type === "text"))).toBe(
      false,
    );
    const images = result.output?.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images?.[0]).toEqual({ type: "image", data, mimeType: "image/png" });
    const decoded = Buffer.from(images![0]!.data, "base64");
    expect(decoded.byteLength).toBe(png.byteLength);
    expect(decoded.equals(png)).toBe(true);
    const saved = await fixture.run('text(load("imagePassed"));');
    expect(saved.output).toContainEqual({ type: "text", text: "true" });
  } finally {
    await fixture.close();
  }
});

it("returns read images as arrays through native nested calls", async () => {
  const picture = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  let reads = 0;
  const fixture = await openCodemodeHarness(
    new CallableCatalog([
      imageReadTool({
        read: (request) => {
          expect(request.path).toBe("picture.png");
          reads++;
          return okAsync({ output: [picture] });
        },
      }),
    ]),
  );
  try {
    const result = await fixture.run(
      'const blocks=await tools.read({path:"picture.png"}); text(Array.isArray(blocks)); text(blocks.length); image(blocks[0]);',
    );
    expect(result.isError).toBe(false);
    const lines = result.output?.flatMap((block) =>
      block.type === "text" ? block.text.split("\n") : [],
    );
    expect(lines).toContain("true");
    expect(lines).toContain("1");
    expect(result.output?.filter((item) => item.type === "image")).toEqual([picture]);
    expect(reads).toBe(1);
  } finally {
    await fixture.close();
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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("returns native image bytes through the remote reader without a second filesystem read", async () => {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=";
  const bytes = Buffer.from(image, "base64");
  let reads = 0;
  const api = {
    now: () => 0,
    agent: async () => ({}),
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
    expect(result._unsafeUnwrap().output).toEqual([
      { type: "image", data: image, mimeType: "image/png" },
    ]);
    expect(result._unsafeUnwrap()).not.toHaveProperty("content");
    expect(reads).toBe(0);
  } finally {
    await tools.close();
  }
});

const rawImageCap = 20 * 1024 * 1024;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngCrc(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

/** Complete RGBA PNG, optionally padded with a private ancillary chunk. */
function policyPng(width: number, totalBytes?: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(1 + width * 4); // Filter 0, one transparent row.
  const ihdr = pngChunk("IHDR", header);
  const idat = pngChunk("IDAT", deflateSync(pixels));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const baseLength = pngSignature.length + ihdr.length + idat.length + iend.length;
  const padding =
    totalBytes === undefined
      ? []
      : [pngChunk("orBp", Buffer.alloc(totalBytes - baseLength - 12, 97))];
  const png = Buffer.concat([pngSignature, ihdr, ...padding, idat, iend]);

  expect(png.subarray(0, 8).equals(pngSignature)).toBe(true);
  expect(png.length).toBe(totalBytes ?? baseLength);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    expect(offset + 12).toBeLessThanOrEqual(png.length);
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    expect(end).toBeLessThanOrEqual(png.length);
    const type = png.toString("ascii", offset + 4, offset + 8);
    expect(type).toMatch(/^[A-Za-z]{2}[A-Z][A-Za-z]$/);
    expect(png.readUInt32BE(end - 4)).toBe(pngCrc(png.subarray(offset + 4, end - 4)));
    chunks.push({ type, data: png.subarray(offset + 8, end - 4) });
    offset = end;
  }
  expect(offset).toBe(png.length);
  expect(chunks.map((chunk) => chunk.type)).toEqual(
    totalBytes === undefined ? ["IHDR", "IDAT", "IEND"] : ["IHDR", "orBp", "IDAT", "IEND"],
  );
  expect(chunks[0]!.data.equals(header)).toBe(true);
  expect(chunks.at(-1)!.data.length).toBe(0);
  const inflated = inflateSync(
    Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)),
  );
  expect(inflated.length).toBe(pixels.length);
  expect(inflated.equals(pixels)).toBe(true);
  return png;
}

async function nativeImageRead(png: Buffer): Promise<ToolExecutionResult> {
  const directory = await mkdtemp(join(tmpdir(), "native-read-image-"));
  const bundle = createDurableTools();
  let fixture: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    await writeFile(join(directory, "image.png"), png);
    fixture = await openCodemodeHarness(bundle.catalog, {
      env: new NodeExecutionEnv({ cwd: directory }),
    });
    return await fixture.run(`
      const blocks = await tools.read({path:"image.png"});
      if (!Array.isArray(blocks)) throw new Error("Expected native read image array");
      for (const block of blocks) if (block.type === "image") image(block);
    `);
  } finally {
    try {
      await fixture?.close();
    } finally {
      await bundle.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function expectUnchangedPng(result: ToolExecutionResult, png: Buffer) {
  const diagnostic = result.output?.filter((block) => block.type === "text");
  expect(result.isError, JSON.stringify(diagnostic)).toBe(false);
  const images = result.output?.filter((block) => block.type === "image") ?? [];
  expect(images).toHaveLength(1);
  expect(images[0]!.mimeType).toBe("image/png");
  const actual = Buffer.from(images[0]!.data, "base64");
  expect(actual.length).toBe(png.length);
  expect(actual.equals(png)).toBe(true);
}

describe("native read raw image policy", () => {
  it("preserves native image read bytes beyond default dimensions", async () => {
    const png = policyPng(2001);
    expectUnchangedPng(await nativeImageRead(png), png);
  });

  it("preserves native image read bytes at exactly 20 MiB raw", async () => {
    const png = policyPng(1, rawImageCap);
    expectUnchangedPng(await nativeImageRead(png), png);
  });

  it("rejects native image reads above 20 MiB raw without emitting an image", async () => {
    const png = policyPng(1, rawImageCap + 1);
    const result = await nativeImageRead(png);
    expect(result.isError).toBe(true);
    expect(result.output?.filter((block) => block.type === "image") ?? []).toHaveLength(0);
    const diagnostic = (result.output ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(diagnostic).toContain("image.png");
    expect(diagnostic).toContain("image");
    expect(diagnostic).toMatch(/too large|cannot be prepared/);
  });

  it("preserves small native PNG reads unchanged", async () => {
    const png = policyPng(1);
    expectUnchangedPng(await nativeImageRead(png), png);
  });
});

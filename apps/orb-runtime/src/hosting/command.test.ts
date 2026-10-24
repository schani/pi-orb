import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferMediaType, parseHostingArgs, uploadHostedFile } from "./command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("pi-orb host command", () => {
  it("parses publish, list, remove, and stable retry identity", () => {
    expect(parseHostingArgs(["ls"])._unsafeUnwrap()).toEqual({ type: "list" });
    expect(parseHostingArgs(["rm", "design/index.html"])._unsafeUnwrap()).toEqual({
      path: "design/index.html",
      type: "remove",
    });
    expect(parseHostingArgs(["page.html"])._unsafeUnwrap()).toMatchObject({
      file: "page.html",
      path: "page.html",
      type: "publish",
    });
    expect(
      parseHostingArgs([
        "page.html",
        "design/index.html",
        "--request-id",
        "550e8400-e29b-41d4-a716-446655440000",
      ])._unsafeUnwrap(),
    ).toEqual({
      file: "page.html",
      path: "design/index.html",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      type: "publish",
    });
    expect(parseHostingArgs([]).isErr()).toBe(true);
  });

  it("infers common media types", () => {
    expect(inferMediaType("index.html")).toBe("text/html; charset=utf-8");
    expect(inferMediaType("asset.unknown")).toBe("application/octet-stream");
  });

  it("streams exact file bytes with independent digest and request headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-host-cli-"));
    roots.push(root);
    const file = join(root, "large.bin");
    const expected = Buffer.alloc(300_000, 7);
    writeFileSync(file, expected);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let headers = new Headers();
    const result = await uploadHostedFile(
      { controlPlaneUrl: "http://control", runtimeToken: "token" },
      {
        file,
        path: "large.bin",
        requestId: "550e8400-e29b-41d4-a716-446655440000",
        type: "publish",
      },
      async (input, init) => {
        expect(String(input)).toBe("http://control/runtime/v1/hosting/files?path=large.bin");
        expect(init?.method).toBe("POST");
        headers = new Headers(init?.headers);
        const body = init?.body;
        expect(body).toBeDefined();
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
          bytes += chunk.byteLength;
        }
        return Response.json(
          {
            file: {
              mediaType: "application/octet-stream",
              path: "large.bin",
              size: bytes,
              updatedAt: 1,
              url: "https://files/s/orb/large.bin",
            },
          },
          { status: 201 },
        );
      },
    );
    expect(result.isOk()).toBe(true);
    expect(bytes).toBe(300_000);
    expect(headers.get("content-length")).toBe("300000");
    expect(headers.get("x-pi-orb-request-id")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("x-pi-orb-sha256")).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });

  it("rejects directories and reports the retry identity after an unknown upload outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-host-cli-errors-"));
    roots.push(root);
    const action = {
      file: root,
      path: "x",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      type: "publish" as const,
    };
    expect(
      (
        await uploadHostedFile({ controlPlaneUrl: "http://control", runtimeToken: "token" }, action)
      ).isErr(),
    ).toBe(true);
    const file = join(root, "x");
    writeFileSync(file, "x");
    const failed = await uploadHostedFile(
      { controlPlaneUrl: "http://control", runtimeToken: "token" },
      { ...action, file },
      async () => Promise.reject(new Error("lost")),
    );
    expect(failed.isErr() && failed.error.message).toContain(action.requestId);
  });
});

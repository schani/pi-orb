import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { SnapshotResourceReader } from "../../domain/resources.ts";
import { createAgentToolFiles } from "./tool-files.ts";

const api = {} as ToolExecutionApi;
const context = BACKGROUND_CONTEXT;
function fixture() {
  const stored = new Map<string, Uint8Array>();
  let offline = true;
  let admitted = true;
  const reader = new SnapshotResourceReader({
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: null,
    files: [
      { path: "AGENTS.md", bytes: Buffer.from("one\ntwo\nthree"), sha256: "" },
      { path: "/opt/pi-orb/skills/skill/SKILL.md", bytes: Buffer.from("platform"), sha256: "" },
      { path: "image.png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), sha256: "" },
      { path: "invalid.bin", bytes: Uint8Array.from([255]), sha256: "" },
      { path: "large.txt", bytes: Buffer.from("é".repeat(30_000)), sha256: "" },
    ],
  });
  const files = createAgentToolFiles({
    reader,
    allowSnapshotRead: () => offline,
    check: () =>
      admitted ? okAsync(undefined) : errAsync({ code: "cancelled", message: "revoked" }),
    artifacts: {
      write: (bytes) => {
        const path = "/orb-artifacts/00000000-0000-0000-0000-000000000001";
        stored.set(path, bytes);
        return okAsync(path);
      },
      read: (path) => okAsync(stored.get(path) ?? null),
    },
  });
  return {
    files,
    stored,
    live: () => {
      offline = false;
    },
    revoke: () => {
      admitted = false;
    },
  };
}
describe("scoped agent files", () => {
  it("reads exact offline aliases selectively and delegates live workspace paths", async () => {
    const f = fixture();
    expect(
      (await f.files.read({ path: "AGENTS.md", offset: 2, limit: 1 }, api, context))._unsafeUnwrap()
        ?.content,
    ).toEqual([{ type: "text", text: "two" }]);
    expect(
      (await f.files.read({ path: "/etc/passwd" }, api, context))._unsafeUnwrap(),
    ).toBeUndefined();
    f.live();
    expect(
      (await f.files.read({ path: "AGENTS.md" }, api, context))._unsafeUnwrap(),
    ).toBeUndefined();
    expect(
      (
        await f.files.read({ path: "/opt/pi-orb/skills/skill/SKILL.md" }, api, context)
      )._unsafeUnwrap()?.content,
    ).toEqual([{ type: "text", text: "platform" }]);
  });
  it("returns supported images and rejects invalid UTF8", async () => {
    const f = fixture();
    expect(
      (await f.files.read({ path: "image.png" }, api, context))._unsafeUnwrap()?.content?.[0],
    ).toMatchObject({ type: "image", mimeType: "image/png" });
    expect((await f.files.read({ path: "invalid.bin" }, api, context)).isErr()).toBe(true);
  });
  it("bounds UTF8 output without splitting characters and reports continuation", async () => {
    const value = (await fixture().files.read({ path: "large.txt" }, api, context))._unsafeUnwrap();
    const text = value?.content?.[0];
    expect(text?.type).toBe("text");
    if (text?.type === "text") {
      expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(50 * 1024);
      expect(text.text).not.toContain("�");
    }
    expect(value?.diagnostics?.[0]?.code).toBe("truncated");
  });
  it("spills scoped bytes and never delegates a missing private reference", async () => {
    const f = fixture();
    const path = (await f.files.spill("saved\noutput", api, context))._unsafeUnwrap();
    expect(
      (await f.files.read({ path, offset: 2 }, api, context))._unsafeUnwrap()?.content,
    ).toEqual([{ type: "text", text: "output" }]);
    expect((await f.files.read({ path: "/orb-artifacts/other" }, api, context)).isErr()).toBe(true);
    expect((await f.files.spill("x".repeat(16 * 1024 * 1024 + 1), api, context)).isErr()).toBe(
      true,
    );
    f.revoke();
    expect((await f.files.read({ path }, api, context)).isErr()).toBe(true);
  });
  it("rechecks admission after artifact reads", async () => {
    let admitted = true;
    const files = createAgentToolFiles({
      reader: new SnapshotResourceReader({
        orbId: "o",
        commitSha: "a".repeat(40),
        instructionPath: null,
        skillRoot: null,
        files: [],
      }),
      allowSnapshotRead: () => true,
      check: () =>
        admitted ? okAsync(undefined) : errAsync({ code: "cancelled", message: "revoked" }),
      artifacts: {
        write: () => okAsync(""),
        read: () => {
          admitted = false;
          return okAsync(Buffer.from("secret"));
        },
      },
    });
    expect((await files.read({ path: "/orb-artifacts/test" }, api, context)).isErr()).toBe(true);
  });
});

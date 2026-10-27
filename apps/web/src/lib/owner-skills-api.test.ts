import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importOwnerSkill, previewOwnerSkill } from "./api.ts";
import { resetBrowserSessionForTest } from "./session.ts";

beforeEach(resetBrowserSessionForTest);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const url = "https://github.com/example/skills/tree/main/handbook";
const commitSha = "a".repeat(40);
const preview = {
  name: "handbook",
  description: "Write manuals.",
  content: "---\nname: handbook\ndescription: Write manuals.\n---\n",
  source: { url, commitSha },
  manifest: [{ path: "SKILL.md", bytes: 57, executable: false }],
  fileCount: 1,
  totalBytes: 57,
};

it("previews with a cancellable typed response and imports only the exact preview pin", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    if (path.endsWith("/preview")) {
      expect(JSON.parse(String(init?.body))).toEqual({ url });
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response(JSON.stringify(preview));
    }
    expect(path).toBe("/api/v1/owner-skills/import");
    expect(JSON.parse(String(init?.body))).toEqual({ url, commitSha });
    return new Response(JSON.stringify({ items: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  expect((await previewOwnerSkill(url, controller.signal))._unsafeUnwrap()).toEqual(preview);
  expect(
    (await importOwnerSkill(preview.source.url, preview.source.commitSha))._unsafeUnwrap(),
  ).toEqual({ items: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects support payloads in lightweight list responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                name: preview.name,
                description: preview.description,
                content: preview.content,
                source: preview.source,
                fileCount: 1,
                totalBytes: 57,
                updatedAt: "",
                files: [{ path: "extra", base64: "YQ==", executable: false }],
              },
            ],
          }),
        ),
    ),
  );
  expect((await importOwnerSkill(url, commitSha))._unsafeUnwrapErr().type).toBe("invalid_response");
});

it("returns typed import network failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  expect((await importOwnerSkill(url, commitSha))._unsafeUnwrapErr()).toEqual({
    type: "network",
    message: "offline",
  });
});

it("budgets the full bounded server acquisition plus its response", async () => {
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => new AbortController().signal);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (path: string) =>
        new Response(JSON.stringify(path.endsWith("/preview") ? preview : { items: [] })),
    ),
  );
  await previewOwnerSkill(url, new AbortController().signal);
  await importOwnerSkill(url, commitSha);
  expect(timeout.mock.calls).toEqual([[190_000], [190_000]]);
  timeout.mockRestore();
});

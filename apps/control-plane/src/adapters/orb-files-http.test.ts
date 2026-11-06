import { afterEach, expect, it, vi } from "vitest";
import { NodeOrbFilesTransport } from "./orb-files-http.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, "repo"] as const)(
  "transports the %s base without resolving paths",
  async (base) => {
    const fetch = vi.fn(
      async () =>
        new Response("data", {
          headers: { "content-length": "4", "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const path = base ? "Review # %.md" : "/tmp/Review # %.md";
    const response = (
      await new NodeOrbFilesTransport().open(
        { baseUrl: "http://runtime", token: "secret", incarnation: 7 },
        { method: "GET", path, ...(base ? { base } : {}) },
        signal,
      )
    )._unsafeUnwrap();
    expect(fetch).toHaveBeenCalledWith(
      `http://runtime/v1/files?${new URLSearchParams({ path, ...(base ? { base } : {}) })}`,
      {
        method: "GET",
        headers: { authorization: "Bearer secret", "x-orb-incarnation": "7" },
        signal,
        redirect: "error",
      },
    );
    const chunks = [];
    if (response.body) for await (const chunk of response.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("data");
  },
);

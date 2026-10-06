import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrb } from "./api.ts";
import { createOrbRequest } from "./create-orb-request.ts";

afterEach(() => vi.unstubAllGlobals());

function browserTimeZone(timeZone?: string) {
  vi.stubGlobal("Intl", {
    DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }),
  });
}

describe("browser orb creation request", () => {
  it("sends an explicit selected Claude harness without changing the Pi default", () => {
    browserTimeZone(undefined);
    expect(createOrbRequest("new-orb", "claude")).toEqual({ id: "new-orb", harness: "claude" });
    expect(createOrbRequest("new-orb")).toEqual({ id: "new-orb" });
  });
  it("sends the browser's zone with the orb ID", async () => {
    browserTimeZone("America/Los_Angeles");
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        id: "new-orb",
        userTimeZone: "America/Los_Angeles",
      });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    await createOrb("project", createOrbRequest("new-orb"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the creation snapshot when the browser zone later changes", () => {
    browserTimeZone("Asia/Tokyo");
    const request = createOrbRequest("new-orb");
    browserTimeZone("Europe/London");
    expect(request).toEqual({ id: "new-orb", userTimeZone: "Asia/Tokyo" });
  });

  it("omits a missing browser zone", () => {
    browserTimeZone(undefined);
    expect(createOrbRequest("new-orb")).toEqual({ id: "new-orb" });
  });

  it("omits a zone when the browser API throws", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => {
        throw new Error("unavailable");
      },
    });
    expect(createOrbRequest("new-orb")).toEqual({ id: "new-orb" });
  });
});

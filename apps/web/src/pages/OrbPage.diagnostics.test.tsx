import type { OrbView } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { getOrb } from "../lib/api.ts";
import { startOrbLoad } from "../lib/orb-load.ts";
import { resetBrowserSessionForTest } from "../lib/session.ts";
import { TranscriptCache } from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { OrbDiagnostics } from "./OrbPage.tsx";

afterEach(() => vi.unstubAllGlobals());

it("shows persisted warnings after GET and reload, then removes cleared warnings", async () => {
  resetBrowserSessionForTest();
  const view: OrbView = {
    id: "a",
    projectId: "p",
    harness: "pi",
    name: null,
    state: "failed",
    stateVersion: 2,
    lastError: "Resource preparation failed",
    resourceWarnings: [{ path: ".agents/skills/bad/SKILL.md", code: "invalid_yaml" }],
    stateChangedAt: "2026-10-09T00:00:00Z",
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  };
  let response = view;
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe("/api/v1/orbs/a");
    return new Response(JSON.stringify(response));
  });
  vi.stubGlobal("fetch", fetch);
  const cache = new TranscriptCache();
  const load = async () => {
    const request = startOrbLoad({
      orbId: "a",
      cache,
      getOrb,
      getHistory: async () => ok(history()),
    });
    const result = await request.result;
    expect(result?.orb.isOk()).toBe(true);
    const orb = result?.orb._unsafeUnwrap();
    return renderToStaticMarkup(<OrbDiagnostics orb={orb ?? null} />);
  };
  const first = await load();
  expect(first).toContain(".agents/skills/bad/SKILL.md");
  expect(first).toContain("invalid YAML");
  expect(first.match(/Resource preparation failed/g)).toHaveLength(1);
  const reloaded = await load();
  expect(reloaded).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(2);
  response = { ...view, resourceWarnings: [] };
  expect(await load()).not.toContain("Skipped repository skill");
});

it("renders nothing before metadata is available", () => {
  expect(renderToStaticMarkup(<OrbDiagnostics orb={null} />)).toBe("");
});

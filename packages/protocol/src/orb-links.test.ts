import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  canonicalGithubLink,
  githubLinkKind,
  githubLinkRef,
  githubRepository,
  OrbLinksResponseSchema,
} from "./orb-links.ts";

describe("canonicalGithubLink", () => {
  it("canonicalizes pull requests, issues and Actions runs", () => {
    expect(canonicalGithubLink("https://github.com/schani/pi-orb/pull/291")).toBe(
      "https://github.com/schani/pi-orb/pull/291",
    );
    expect(canonicalGithubLink("https://www.github.com/schani/pi-orb/pull/291/files?w=1#r1")).toBe(
      "https://github.com/schani/pi-orb/pull/291",
    );
    expect(canonicalGithubLink("http://github.com/schani/pi-orb/issues/285/")).toBe(
      "https://github.com/schani/pi-orb/issues/285",
    );
    expect(canonicalGithubLink("https://github.com/schani/pi-orb/actions/runs/1187/job/9")).toBe(
      "https://github.com/schani/pi-orb/actions/runs/1187",
    );
  });

  it("rejects anything else", () => {
    for (const url of [
      "https://github.com/schani/pi-orb",
      "https://github.com/schani/pi-orb/pull/abc",
      "https://gitlab.com/schani/pi-orb/pull/1",
      "https://github.com.evil.test/schani/pi-orb/pull/1",
      "https://user@github.com/schani/pi-orb/pull/1",
      "not a url",
    ])
      expect(canonicalGithubLink(url)).toBeNull();
  });
});

describe("githubRepository", () => {
  it("names GitHub repositories only", () => {
    expect(githubRepository("https://github.com/schani/pi-orb.git")).toBe("schani/pi-orb");
    expect(githubRepository("https://github.com/Schani/Pi-Orb")).toBe("schani/pi-orb");
    expect(githubRepository("https://gitlab.com/schani/pi-orb")).toBeNull();
    expect(githubRepository(null)).toBeNull();
  });
});

describe("githubLinkRef", () => {
  it("omits the repository only when it is the project's own", () => {
    const own = "schani/pi-orb";
    expect(githubLinkRef("https://github.com/schani/pi-orb/pull/291", own)).toBe("#291");
    expect(githubLinkRef("https://github.com/Schani/Pi-Orb/issues/285", own)).toBe("#285");
    expect(githubLinkRef("https://github.com/schani/pi-orb/actions/runs/1187", own)).toBe("1187");
    expect(githubLinkRef("https://github.com/schani/determined/pull/14", own)).toBe(
      "determined#14",
    );
    expect(githubLinkRef("https://github.com/schani/determined/actions/runs/52", null)).toBe(
      "determined 52",
    );
  });
});

describe("githubLinkKind", () => {
  it("names pull requests, issues and Actions runs", () => {
    expect(githubLinkKind("https://github.com/schani/pi-orb/pull/291")).toBe("pull");
    expect(githubLinkKind("https://github.com/schani/pi-orb/issues/285")).toBe("issue");
    expect(githubLinkKind("https://github.com/schani/pi-orb/actions/runs/1187")).toBe("run");
    expect(githubLinkKind("not a url")).toBeNull();
  });
});

describe("links response", () => {
  it("accepts links with and without GitHub status", () => {
    expect(
      Check(OrbLinksResponseSchema, {
        repository: "schani/pi-orb",
        githubError: null,
        items: [
          {
            url: "https://github.com/schani/pi-orb/pull/291",
            addedAt: 1,
            github: {
              title: "Add links",
              status: "draft",
              diff: { additions: 525, deletions: 38 },
              comments: null,
              checks: [
                {
                  id: "CR_1",
                  name: "e2e",
                  result: "running",
                  url: null,
                  startedAt: 2,
                  completedAt: null,
                },
              ],
            },
          },
          { url: "https://github.com/schani/pi-orb/issues/285", addedAt: 2, github: null },
        ],
      }),
    ).toBe(true);
  });
});

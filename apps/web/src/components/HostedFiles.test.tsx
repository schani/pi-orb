import type { HostedFilesResponse } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostedFiles } from "./HostedFiles.tsx";

describe("HostedFiles", () => {
  it("renders archived inventory links, sizes, dates, and cleanup failures", () => {
    const inventory: HostedFilesResponse = {
      files: [
        {
          path: "site/index.html",
          url: "https://files.test/s/orb/site/index.html",
          size: 1536,
          mediaType: "text/html",
          updatedAt: 1_788_739_200_000,
        },
      ],
      cleanupIssues: [
        { path: "old.txt", lastError: "deletion failed", lastErrorAt: 1_788_739_201_000 },
      ],
    };
    const html = renderToStaticMarkup(<HostedFiles inventory={inventory} error={null} />);
    expect(html).toContain('href="https://files.test/s/orb/site/index.html"');
    expect(html).toContain("site/index.html");
    expect(html).toContain("1.5 KiB");
    expect(html).toContain("deletion failed");
    expect(html).not.toContain("sha256");
  });

  it("does not render an unsafe provider URL as a link", () => {
    const inventory = {
      files: [
        {
          path: "bad.html",
          url: "javascript:alert(1)",
          size: 1,
          mediaType: "text/html",
          updatedAt: 1,
        },
      ],
      cleanupIssues: [],
    } as HostedFilesResponse;
    const html = renderToStaticMarkup(<HostedFiles inventory={inventory} error={null} />);
    expect(html).toContain("bad.html");
    expect(html).not.toContain("href=");
  });

  it("hides an empty successful inventory", () => {
    expect(
      renderToStaticMarkup(
        <HostedFiles inventory={{ files: [], cleanupIssues: [] }} error={null} />,
      ),
    ).toBe("");
  });
});

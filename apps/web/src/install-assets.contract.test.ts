import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(import.meta.dirname, "..");
const icons = [
  [180, "/favicons/apple-touch-icon.png"],
  [192, "/favicons/app-192.png"],
  [512, "/favicons/app-512.png"],
] as const;

describe("home-screen install assets", () => {
  it("declares a credentialed manifest and Apple standalone metadata without changing viewport fit", () => {
    const html = readFileSync(join(webRoot, "index.html"), "utf8");
    const manifest = html.match(/<link\b[^>]*\brel="manifest"[^>]*>/)?.[0];
    expect(manifest).toContain('href="/manifest.webmanifest"');
    expect(manifest).toContain('crossorigin="use-credentials"');
    expect(html).toContain(
      'rel="apple-touch-icon" sizes="180x180" href="/favicons/apple-touch-icon.png"',
    );
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="pi-orb"');
    expect(html).toContain('name="theme-color" content="#ffffff"');
    expect(html).not.toContain("viewport-fit=");
    expect(html).not.toContain("apple-mobile-web-app-status-bar-style");
    expect(html).toContain(
      'id="pi-orb-favicon" rel="icon" type="image/svg+xml" href="/favicons/neutral.svg"',
    );
  });

  it("launches the dashboard under a stable app identity", () => {
    const manifest = JSON.parse(readFileSync(join(webRoot, "public/manifest.webmanifest"), "utf8"));
    expect(manifest).toEqual({
      id: "/",
      name: "pi-orb",
      short_name: "pi-orb",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [
        { src: "/favicons/app-192.png", sizes: "192x192", type: "image/png" },
        { src: "/favicons/app-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it.each(icons)("ships an opaque %ipx PNG at %s", (size, path) => {
    const png = readFileSync(join(webRoot, "public", path));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(2); // RGB, without an alpha channel.
    const chunks: string[] = [];
    for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
      chunks.push(png.toString("ascii", offset + 4, offset + 8));
    }
    expect(chunks).not.toContain("tRNS");
    expect(chunks.at(-1)).toBe("IEND");
  });
});

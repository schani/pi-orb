import { describe, expect, it } from "vitest";
import { resolveOrbFileUrl } from "./orb-file-url.ts";

const BASE = "https://files.example/files/11111111-1111-4111-8111-111111111111";

describe("orb file URL path validation", () => {
  it.each([
    "orb:dir\\file",
    "orb:/tmp/\\file",
    "orb:dir/\u0000file",
    "orb:dir/\tfile",
    "orb:dir/\nfile",
    "orb:dir/\u007ffile",
    "orb:dir/%C2%80file",
    "orb:dir/\ud800",
    "orb:./README.md",
    "orb:/tmp/../secret",
    "orb:/tmp//file",
    "orb:report.html?bad=%",
    "orb:report.html#%ZZ",
    "orb:report.html?bad=%00",
    "orb:report.html#bad\\\\path",
  ])("rejects raw and decoded invalid paths before URL normalization: %s", (uri) => {
    expect(resolveOrbFileUrl(uri, BASE).isErr()).toBe(true);
  });

  it.each([
    ["orb:雪/100%25.txt", "/files/repo/11111111-1111-4111-8111-111111111111/%E9%9B%AA/100%25.txt"],
    ["orb:/tmp/a%3Fb%23c", "/files/11111111-1111-4111-8111-111111111111/tmp/a%3Fb%23c"],
    [
      "orb:report.html?path=/../other#file",
      "/files/repo/11111111-1111-4111-8111-111111111111/report.html?path=/../other#file",
    ],
  ])(
    "encodes each path segment once without letting suffixes change file identity",
    (uri, path) => {
      expect(resolveOrbFileUrl(uri, BASE)._unsafeUnwrap()).toBe(`https://files.example${path}`);
    },
  );

  it("supports explicitly configured HTTP origins", () => {
    expect(
      resolveOrbFileUrl("orb:README.md", BASE.replace("https:", "http:"))._unsafeUnwrap(),
    ).toBe("http://files.example/files/repo/11111111-1111-4111-8111-111111111111/README.md");
  });
});

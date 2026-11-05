import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const lock = JSON.parse(
  readFileSync(new URL("../../../../package-lock.json", import.meta.url), "utf8"),
) as {
  packages: Record<string, { version?: string }>;
};

it.each([
  ["fastify", "5.12.8"],
  ["find-my-way", "9.10.0"],
  ["@fastify/static", "10.1.8"],
  ["@fastify/websocket", "11.3.6"],
  ["ws", "8.22.1"],
  ["openid-client", "6.8.9"],
  ["tldts", "7.4.19"],
  ["undici", "8.12.3"],
])("locks every %s consumer to the qualified version", (name, version) => {
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path.endsWith(`node_modules/${name}`),
  );
  expect(copies.length).toBeGreaterThan(0);
  for (const [path, pkg] of copies) expect(pkg.version, path).toBe(version);
});

it("updates Google auth 11 without replacing legacy provider auth 10", () => {
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path.endsWith("node_modules/google-auth-library")) {
      expect(pkg.version, path).toBe(
        path === "node_modules/google-auth-library" ? "10.5.0" : "11.3.3",
      );
    }
  }
});

it("removes affected glob/minimatch copies and locks Pi and Chord to 1.5.0", () => {
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (/node_modules\/(?:glob|minimatch)$/.test(path)) {
      expect(path.endsWith("/glob") ? ["14.0.3"] : ["11.0.1", "11.0.2", "11.0.3"]).toContain(
        pkg.version,
      );
    }
    if (/^node_modules\/@earendil-works\/(?:pi-[^/]+|chord)$/.test(path)) {
      expect(pkg.version, path).toBe("1.5.0");
    }
  }
});

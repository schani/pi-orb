import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../../..");
const wrapper = dirname(fileURLToPath(import.meta.resolve("@electric-sql/pglite-pg_textsearch")));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("pins the PGlite engine to the wrapper's exact peer", () => {
  const dependencies = json(join(root, "apps/control-plane/package.json")).dependencies;
  const packages = json(join(root, "package-lock.json")).packages;
  expect(dependencies["@electric-sql/pglite"]).toBe("0.5.17");
  expect(dependencies["@electric-sql/pglite-pg_textsearch"]).toBe("0.0.19");
  expect(json(join(wrapper, "../package.json")).version).toBe("0.0.19");
  expect(json(join(root, "node_modules/@electric-sql/pglite/package.json")).version).toBe("0.5.17");
  expect(packages["apps/control-plane"].dependencies).toEqual(dependencies);
  expect(packages["node_modules/@electric-sql/pglite"].version).toBe("0.5.17");
  expect(packages["node_modules/@electric-sql/pglite-pg_textsearch"].version).toBe("0.0.19");
  expect(json(join(wrapper, "../package.json")).peerDependencies).toEqual({
    "@electric-sql/pglite": "0.5.17",
  });
});

it("ships the reviewed wrapper JS and embedded 1.5.1 extension payload", () => {
  expect(sha256(readFileSync(join(wrapper, "index.js")))).toBe(
    "1462a8323f7180a6e5dbbdb49caf9f66440f95cfce825ea9d722a4393f432a13",
  );
  expect(sha256(readFileSync(join(wrapper, "index.cjs")))).toBe(
    "973aff9cf358358f7e982d7ab79d0c88ca2ce1df7fe2800ad697738d0db3c56a",
  );
  const archive = join(wrapper, "pg_textsearch.tar.gz");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => !entry.endsWith("/"))
    .sort();
  const payload = createHash("sha256");
  for (const entry of entries) {
    payload.update(entry);
    payload.update(execFileSync("tar", ["-xzOf", archive, entry]));
  }
  expect(entries).toHaveLength(25);
  expect(payload.digest("hex")).toBe(
    "60ead7c09fc4e11474c9a8e8337ee1b3f0d3b7ce19bf0d6b45ee341812cb2aaf",
  );
  expect(sha256(execFileSync("tar", ["-xzOf", archive, "lib/postgresql/pg_textsearch.so"]))).toBe(
    "58e660570e3037435c86a85541c215954d053804676a3bf575cd8d8212007c8f",
  );
});

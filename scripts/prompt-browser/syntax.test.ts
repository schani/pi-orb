// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures contain literal template syntax.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PromptService } from "./service.ts";
import { SourceAdapter } from "./source.ts";

test("JavaScript and TSX prose saves escape code instead of executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-syntax-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const extension of ["js", "tsx"]) {
    const path = `source.${extension}`;
    const original =
      extension === "tsx"
        ? "export const text = 'hello';\nconst node = <p>é 🦊</p>;\n"
        : "export const text = 'hello';\n";
    await writeFile(join(root, path), original);
    const service = new PromptService(new SourceAdapter(root), [
      {
        id: "source",
        path,
        title: "Source",
        category: "Test",
        scope: "Checkout",
        editable: true,
        selector: { kind: "code", owner: { kind: "variable", name: "text" }, node: "string" },
      },
    ]);
    const entry = (await service.list())._unsafeUnwrap()[0];
    const content = '"; process.exit(42); ${danger} ` <p>é 🦊</p>\n';
    assert.equal(
      (await service.save("source", { content, revision: entry.revision })).isOk(),
      true,
    );
    assert.equal(
      await readFile(join(root, path), "utf8"),
      original.replace("'hello'", JSON.stringify(content)),
    );
    assert.equal((await service.list())._unsafeUnwrap()[0].content, content);
  }
});
test("invalid containing source is rejected without edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-syntax-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = 'const text = "hello"; const = ;';
  await writeFile(join(root, "invalid.ts"), original);
  const source = new SourceAdapter(root);
  const definition = {
    id: "source",
    path: "invalid.ts",
    title: "Source",
    category: "Test",
    scope: "Checkout",
    editable: true,
    selector: { kind: "code", owner: { kind: "variable", name: "text" }, node: "string" },
  } as const;
  assert.equal((await source.read(definition))._unsafeUnwrapErr().code, "syntax");
  assert.equal(await readFile(join(root, "invalid.ts"), "utf8"), original);
});

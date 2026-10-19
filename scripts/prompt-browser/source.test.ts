// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures contain literal template syntax.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ResultAsync } from "neverthrow";
import { PromptService } from "./service.ts";
import { SourceAdapter } from "./source.ts";
import type { Definition } from "./types.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original =
    'import privateModule from "private-module";\r\n// before é 🦊\r\nexport const prompt: string = "hello";\r\nconst sibling = `Welcome ${ user.secret({deep:`nested ${x}`}) }`;\r\nexecute(privateModule); // after\r\n';
  await writeFile(join(root, "prompt.ts"), original);
  await writeFile(
    join(root, "notes.md"),
    "---\nname: sample\ndescription: Simple description.\n---\nplain 🦊\n",
  );
  const catalog: Definition[] = [
    {
      id: "ts",
      title: "TS",
      category: "System",
      scope: "Checkout",
      path: "prompt.ts",
      editable: true,
      selector: { kind: "code", owner: { kind: "variable", name: "prompt" }, node: "string" },
    },
    {
      id: "sibling",
      title: "Sibling",
      category: "System",
      scope: "Checkout",
      path: "prompt.ts",
      editable: true,
      selector: {
        kind: "code",
        owner: { kind: "variable", name: "sibling" },
        node: "template",
        variables: ["person"],
      },
    },
    {
      id: "md",
      title: "Markdown",
      category: "Skills",
      scope: "Checkout",
      path: "notes.md",
      editable: true,
      selector: { kind: "markdown-body" },
    },
    {
      id: "description",
      title: "Description",
      category: "Skills",
      scope: "Checkout",
      path: "notes.md",
      editable: true,
      selector: { kind: "frontmatter-description" },
    },
    {
      id: "locked",
      title: "Upstream",
      category: "Upstream",
      scope: "Installed",
      path: "prompt.ts",
      editable: false,
      selector: { kind: "code", owner: { kind: "variable", name: "prompt" }, node: "string" },
    },
  ];
  return {
    root,
    original,
    catalog,
    adapter: new SourceAdapter(root),
    service: new PromptService(new SourceAdapter(root), catalog),
  };
}
test("public entries contain only decoded prompt prose and public metadata", async (t) => {
  const { service, original, root } = await fixture(t);
  const entries = (await service.list())._unsafeUnwrap();
  assert.equal(entries[0].content, "hello");
  assert.equal(entries[1].content, "Welcome {{person}}");
  const serialized = JSON.stringify(entries);
  for (const secret of [
    "private-module",
    "execute(",
    "user.secret",
    "deep:",
    '"path"',
    '"selector"',
    '"sourcePath"',
    '"packagePath"',
  ])
    assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(Object.keys(entries[0]).sort(), [
    "category",
    "content",
    "editable",
    "id",
    "revision",
    "scope",
    "title",
  ]);
  assert.equal(entries[0].revision, entries[1].revision);
  const noOp = (
    await service.save("ts", { content: "hello", revision: entries[0].revision })
  )._unsafeUnwrap();
  assert.equal(noOp.revision, entries[0].revision);
  assert.equal(await readFile(join(root, "prompt.ts"), "utf8"), original);
  const content = 'new\n"quote" \\ ` ${literal} 🦊';
  const saved = (
    await service.save("ts", { content, revision: entries[0].revision })
  )._unsafeUnwrap();
  assert.equal(saved.content, content);
  assert.equal(
    await readFile(join(root, "prompt.ts"), "utf8"),
    original.replace('"hello"', JSON.stringify(content)),
  );
  assert.notEqual(saved.revision, entries[0].revision);
  assert.equal(
    (
      await service.save("sibling", { content: "Hi {{person}}", revision: entries[1].revision })
    )._unsafeUnwrapErr().code,
    "conflict",
  );
  const reloaded = (await service.list())._unsafeUnwrap()[1];
  assert.equal(
    (
      await service.save("sibling", { content: "Hi {{person}}", revision: reloaded.revision })
    ).isOk(),
    true,
  );
  assert.ok(
    (await readFile(join(root, "prompt.ts"), "utf8")).includes(
      "${ user.secret({deep:`nested ${x}`}) }",
    ),
  );
});
test("parallel saves, external changes, unknown IDs, read-only and bounds", async (t) => {
  const { service, root, original, adapter, catalog } = await fixture(t);
  const entry = (await service.list())._unsafeUnwrap()[0];
  const results = await Promise.all(
    ["one", "two"].map((content) => service.save("ts", { content, revision: entry.revision })),
  );
  assert.equal(results.filter((r) => r.isOk()).length, 1);
  assert.equal(results.find((r) => r.isErr())?._unsafeUnwrapErr().code, "conflict");
  const current = (await service.list())._unsafeUnwrap()[0];
  await writeFile(join(root, "prompt.ts"), `${original}// external\n`);
  assert.equal(
    (await service.save("ts", { content: "new", revision: current.revision }))._unsafeUnwrapErr()
      .code,
    "conflict",
  );
  assert.equal(
    (await service.save("absent", { content: "new", revision: entry.revision }))._unsafeUnwrapErr()
      .code,
    "not_found",
  );
  assert.equal(
    (await service.save("locked", { content: "new", revision: entry.revision }))._unsafeUnwrapErr()
      .code,
    "read_only",
  );
  assert.equal(
    (await adapter.save(catalog[4], "new", entry.revision))._unsafeUnwrapErr().code,
    "read_only",
  );
  assert.equal(
    (
      await service.save("ts", { content: "x".repeat(1_048_577), revision: entry.revision })
    )._unsafeUnwrapErr().code,
    "too_large",
  );
  assert.equal(
    (await service.save("ts", { content: "x", revision: "bad" }))._unsafeUnwrapErr().code,
    "invalid_request",
  );
});
test("invalid placeholders never modify source; markdown body and description conflict as siblings", async (t) => {
  const { service, root, original } = await fixture(t);
  const entries = (await service.list())._unsafeUnwrap();
  assert.equal(
    (
      await service.save("sibling", { content: "Hello", revision: entries[1].revision })
    )._unsafeUnwrapErr().code,
    "invalid_request",
  );
  assert.equal(await readFile(join(root, "prompt.ts"), "utf8"), original);
  const saved = (
    await service.save("md", { content: "# Changed\n", revision: entries[2].revision })
  )._unsafeUnwrap();
  assert.equal(
    await readFile(join(root, "notes.md"), "utf8"),
    "---\nname: sample\ndescription: Simple description.\n---\n# Changed\n",
  );
  assert.equal(
    (
      await service.save("description", { content: "New", revision: entries[3].revision })
    )._unsafeUnwrapErr().code,
    "conflict",
  );
  const description = (await service.list())._unsafeUnwrap()[3];
  assert.equal(description.revision, saved.revision);
  assert.equal(
    (
      await service.save("description", {
        content: 'Say "hello"\nagain',
        revision: description.revision,
      })
    ).isOk(),
    true,
  );
  assert.equal((await service.list())._unsafeUnwrap()[3].content, 'Say "hello"\nagain');
  assert.ok((await readFile(join(root, "notes.md"), "utf8")).endsWith("# Changed\n"));
});
test("missing and ambiguous selectors return safe errors, never source", async (t) => {
  const { adapter, catalog, root } = await fixture(t);
  for (const selector of [
    undefined,
    { kind: "code", owner: { kind: "variable", name: "absent" }, node: "string" } as const,
    { kind: "code", node: "string" } as const,
  ]) {
    const { selector: _original, ...definition } = catalog[0];
    const result = await adapter.read({ ...definition, ...(selector ? { selector } : {}) });
    assert.equal(result.isErr(), true);
    assert.equal(JSON.stringify(result).includes("private-module"), false);
  }
  await writeFile(join(root, "prompt.ts"), 'const prompt = "a"; const prompt = "b";');
  assert.equal((await adapter.read(catalog[0])).isErr(), true);
});
test("reject traversal and symlink escapes, including parent directory", async (t) => {
  const { root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "prompt-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.md"), "secret");
  await symlink(join(outside, "secret.md"), join(root, "escape.md"));
  await symlink(outside, join(root, "escape"));
  for (const path of ["../secret.md", "/etc/passwd", "escape.md", "escape/secret.md"]) {
    const service = new PromptService(new SourceAdapter(root), [
      {
        id: "bad",
        title: "Bad",
        category: "Test",
        scope: "Checkout",
        path,
        editable: true,
        selector: { kind: "markdown" },
      },
    ]);
    assert.equal((await service.list())._unsafeUnwrapErr().code, "unsafe_path");
  }
});
test("invalid installed package metadata returns typed errors from read and list", async (t) => {
  const { adapter, catalog, root } = await fixture(t);
  const definition = { ...catalog[0], packagePath: "package.json" } as Definition;
  const service = new PromptService(adapter, [definition]);
  for (const metadata of [null, [], 42, { name: "upstream" }, { name: 3, version: "1" }]) {
    await writeFile(join(root, "package.json"), JSON.stringify(metadata));
    const read = await adapter.read(definition);
    assert.equal(read.isErr(), true);
    assert.equal(read._unsafeUnwrapErr().code, "io");
    const listed = await service.list();
    assert.equal(listed.isErr(), true);
    assert.equal(listed._unsafeUnwrapErr().code, "io");
  }
});

test("installed prompts use identical extraction, package metadata and read-only policy", async (t) => {
  const { root, adapter, catalog } = await fixture(t);
  await writeFile(join(root, "package.json"), '{"name":"upstream","version":"1.2.3"}');
  const definition = {
    ...catalog[4],
    scope: "Central durable · root + child",
    packagePath: "package.json",
  };
  const entry = (await adapter.read(definition))._unsafeUnwrap();
  assert.equal(entry.content, "hello");
  assert.equal(entry.scope, `${definition.scope} · upstream@1.2.3`);
  assert.equal(entry.editable, false);
  assert.equal(JSON.stringify(entry).includes("packagePath"), false);
  const { selector: _original, ...withoutSelector } = definition;
  const unsupported = (
    await adapter.read({
      ...withoutSelector,
      content: "Unavailable: unsupported installed prompt.",
    })
  )._unsafeUnwrap();
  assert.equal(unsupported.content, "Unavailable: unsupported installed prompt.");
});

test("snapshot is read-only and serialized with saves using the existing source queue", async (t) => {
  const { root, original, catalog, adapter } = await fixture(t);
  const definition = catalog[0];
  assert.ok(definition);
  const first = (await adapter.read(definition))._unsafeUnwrap();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const asset = adapter.asset.bind(adapter);
  let intercepted = false;
  adapter.asset = (path) => {
    if (intercepted) return asset(path);
    intercepted = true;
    entered();
    return ResultAsync.fromSafePromise(gate).andThen(() => asset(path));
  };
  const snapshot = adapter.snapshot(catalog, [
    {
      id: first.id,
      content: 'DRAFT "; process.exit(42); ${danger} 🦊',
      revision: first.revision,
    },
  ]);
  await started;
  const saved = adapter.save(definition, "SAVED", first.revision);
  assert.equal(await readFile(join(root, "prompt.ts"), "utf8"), original);
  release();
  const staged = (await snapshot)._unsafeUnwrap();
  assert.equal(staged.entries[0]?.content, 'DRAFT "; process.exit(42); ${danger} 🦊');
  assert.equal((await saved)._unsafeUnwrap().content, "SAVED");
  assert.equal((await adapter.read(definition))._unsafeUnwrap().content, "SAVED");
});

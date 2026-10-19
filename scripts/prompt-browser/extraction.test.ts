// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures contain literal template syntax.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extract } from "./extraction.ts";
import type { ExtractionSelector } from "./types.ts";

const variable = (
  name: string,
  node: "string" | "template" | "joined-array",
  variables?: string[],
): ExtractionSelector => ({
  kind: "code",
  owner: { kind: "variable", name },
  node,
  ...(variables ? { variables } : {}),
});

test("extracts decoded prose only, without imports or implementation", () => {
  const source =
    'import secret from "secret-package";\nconst unrelated = "PRIVATE";\nexport const POLICY: string = "Hi\\nété 🦊 \\"quoted\\"";\nexecute(secret);';
  const prompt = extract("prompt.ts", source, variable("POLICY", "string"))._unsafeUnwrap();
  assert.equal(prompt.content, 'Hi\nété 🦊 "quoted"');
  const replacement = 'new\n"quote" \\ backtick ` ${literal} 🦊';
  const changed = prompt.replace(replacement)._unsafeUnwrap();
  assert.equal(changed, source.replace('"Hi\\nété 🦊 \\"quoted\\""', JSON.stringify(replacement)));
  assert.equal(
    extract("prompt.ts", changed, variable("POLICY", "string"))._unsafeUnwrap().content,
    replacement,
  );
  assert.equal(prompt.replace(prompt.content)._unsafeUnwrap(), source);
});

test("nested template expressions stay private and byte-identical; tokens immutable", () => {
  const expression = "user.get({ key: `nested ${ secret }` }) /* private */";
  const source = `const prefix = "🦊";\nconst environmentPrompt = \`Welcome \${${expression}}!\\nToday \${ clock.now() }.\`; // tail`;
  const selector = variable("environmentPrompt", "template", ["person", "date"]);
  const prompt = extract("prompt.ts", source, selector)._unsafeUnwrap();
  assert.equal(prompt.content, "Welcome {{person}}!\nToday {{date}}.");
  assert.deepEqual(prompt.variables, ["person", "date"]);
  const edited = "🦊 ` \\ ${literal}\n{{person}}! {{date}}";
  const changed = prompt.replace(edited)._unsafeUnwrap();
  assert.ok(changed.includes(`\${${expression}}`));
  assert.ok(changed.includes("${ clock.now() }"));
  assert.ok(changed.startsWith('const prefix = "🦊";\nconst environmentPrompt = `'));
  assert.ok(changed.endsWith("`; // tail"));
  assert.equal(extract("prompt.ts", changed, selector)._unsafeUnwrap().content, edited);
  for (const invalid of [
    "{{date}} {{person}}",
    "{{person}}",
    "{{person}}{{person}}{{date}}",
    "{{person}}{{other}}{{date}}",
  ]) {
    assert.equal(prompt.replace(invalid)._unsafeUnwrapErr().code, "invalid_request");
  }
  assert.equal(prompt.replace(prompt.content)._unsafeUnwrap(), source);
});

test("variable-free templates allow literal placeholder examples", () => {
  const source = "const prompt = `Write {{example}} literally.`;";
  const selector = variable("prompt", "template");
  const prompt = extract("a.ts", source, selector)._unsafeUnwrap();
  assert.equal(prompt.content, "Write {{example}} literally.");
  const content = "Use {{another}} and ` ${literal} \\ safely.";
  const changed = prompt.replace(content)._unsafeUnwrap();
  assert.equal(extract("a.ts", changed, selector)._unsafeUnwrap().content, content);
});

test("joined-array errors identify immutable separator boundaries", () => {
  for (const separator of ["\\n", " | "]) {
    const source = `const aux = ["first", dynamic, "last"].join(${JSON.stringify(separator)});`;
    const prompt = extract(
      "a.ts",
      source,
      variable("aux", "joined-array", ["context"]),
    )._unsafeUnwrap();
    const error = prompt.replace("first {{context}} last")._unsafeUnwrapErr();
    assert.equal(error.code, "invalid_request");
    assert.match(error.message, /separator/i);
    assert.doesNotMatch(error.message, /unchanged and in order/);
  }
});

test("joined arrays insert prose into absent static gaps without changing expressions", () => {
  const prose = 'été 🦊\n"quoted" `backticks` ${plain} \\';
  const expression = "context.get({ key: `nested ${secret}` /* private */ })";
  const cases = [
    {
      source: `const aux = [/* before */ ${expression}].join("\\n"); // tail`,
      variables: ["context"],
      content: `${prose}\n{{context}}`,
      expected: `const aux = [/* before */ ${JSON.stringify(prose)},${expression}].join("\\n"); // tail`,
    },
    {
      source: `const aux = ["Name the user", ${expression}, /* trailing */].join("\\n"); // tail`,
      variables: ["quoted_context"],
      content: `Name the user\n{{quoted_context}}\n${prose}`,
      expected: `const aux = ["Name the user", ${expression},${JSON.stringify(prose)}, /* trailing */].join("\\n"); // tail`,
    },
    {
      source: `const aux = [${expression}, /* between */ ...other.values].join("\\n\\n"); // tail`,
      variables: ["context", "other"],
      content: `{{context}}\n\n${prose}\n\n{{other}}`,
      expected: `const aux = [${expression}, /* between */ ${JSON.stringify(prose)},...other.values].join("\\n\\n"); // tail`,
    },
  ];
  for (const fixture of cases) {
    const selector = variable("aux", "joined-array", fixture.variables);
    const prompt = extract("a.ts", fixture.source, selector)._unsafeUnwrap();
    assert.equal(prompt.replace(prompt.content)._unsafeUnwrap(), fixture.source);
    const changed = prompt.replace(fixture.content)._unsafeUnwrap();
    assert.equal(changed, fixture.expected);
    const extracted = extract("a.ts", changed, selector)._unsafeUnwrap();
    assert.equal(extracted.content, fixture.content);
    assert.equal(extracted.replace(extracted.content)._unsafeUnwrap(), changed);
  }
});

test("absent joined-array gaps still require complete separator boundaries", () => {
  const source = 'const aux = [first, second].join(" | ");';
  const selector = variable("aux", "joined-array", ["first", "second"]);
  const prompt = extract("a.ts", source, selector)._unsafeUnwrap();
  assert.equal(prompt.replace(prompt.content)._unsafeUnwrap(), source);
  for (const content of [
    "prefix{{first}} | {{second}}",
    "{{first}} | {{second}}suffix",
    "{{first}} | middle{{second}}",
    "{{first}}middle | {{second}}",
    "{{first}}{{second}}",
  ]) {
    const error = prompt.replace(content)._unsafeUnwrapErr();
    assert.equal(error.code, "invalid_request");
    assert.match(error.message, /separator/i);
  }
  const edited = "prefix | {{first}} | {{second}} | suffix";
  const changed = prompt.replace(edited)._unsafeUnwrap();
  assert.equal(extract("a.ts", changed, selector)._unsafeUnwrap().content, edited);
});

test("tool description by literal name; function structural paths and ordinals", () => {
  const source =
    'const tools = [{ name: "read", description: flag ? "Read first" : "Read second", execute: () => "PRIVATE" }, {name:"write", description:"Write prose"}]; function announce(){ return `Hello ${who()}`; }';
  assert.equal(
    extract("a.ts", source, {
      kind: "code",
      owner: { kind: "tool", name: "write" },
      node: "string",
    })._unsafeUnwrap().content,
    "Write prose",
  );
  assert.equal(
    extract("a.ts", source, {
      kind: "code",
      owner: { kind: "tool", name: "read" },
      path: ["consequent"],
      node: "string",
    })._unsafeUnwrap().content,
    "Read first",
  );
  assert.equal(
    extract("a.ts", source, {
      kind: "code",
      owner: { kind: "tool", name: "read" },
      node: "string",
      ordinal: 1,
    })._unsafeUnwrap().content,
    "Read second",
  );
  assert.equal(
    extract("a.ts", source, {
      kind: "code",
      owner: { kind: "function", name: "announce" },
      path: ["body", "body", 0, "argument"],
      node: "template",
      variables: ["person"],
    })._unsafeUnwrap().content,
    "Hello {{person}}",
  );
});

test("class method owners select only the named method", () => {
  const source =
    'class Mcp { registerResources(){ return "Resource instructions"; } other(){ return "private"; } }';
  const selector: ExtractionSelector = {
    kind: "code",
    owner: { kind: "function", name: "registerResources" },
    node: "string",
  };
  assert.equal(extract("a.ts", source, selector)._unsafeUnwrap().content, "Resource instructions");
});

test("joined spread items are opaque protected placeholders", () => {
  const source =
    'function boot(){ return ["Hook instructions", ...failed.map(x => x.secret), "Environment", ...envProblems].join("\\n"); }';
  const selector: ExtractionSelector = {
    kind: "code",
    owner: { kind: "function", name: "boot" },
    node: "joined-array",
    variables: ["hookFailures", "environmentProblems"],
  };
  const prompt = extract("a.ts", source, selector)._unsafeUnwrap();
  assert.equal(
    prompt.content,
    "Hook instructions\n{{hookFailures}}\nEnvironment\n{{environmentProblems}}",
  );
  const edited = "New instructions\n{{hookFailures}}\nEnvironment\n{{environmentProblems}}";
  const changed = prompt.replace(edited)._unsafeUnwrap();
  assert.equal(changed, source.replace('"Hook instructions"', '"New instructions"'));
  assert.equal(extract("a.ts", changed, selector)._unsafeUnwrap().content, edited);
  assert.equal(
    prompt.replace("New instructions\n{{environmentProblems}}\n{{hookFailures}}").isErr(),
    true,
  );
});

test("selectors fail closed for missing, ambiguous and unsupported sources", () => {
  for (const selector of [
    undefined,
    variable("absent", "string"),
    { kind: "code", node: "string" } as const,
  ]) {
    assert.equal(
      extract("a.ts", 'const x = "secret"; const y = "implementation";', selector).isErr(),
      true,
    );
  }
  assert.equal(
    extract("a.ts", 'const x = call("secret")', variable("x", "template")).isErr(),
    true,
  );
  assert.equal(
    extract("a.ts", 'const = "secret"', variable("x", "string"))._unsafeUnwrapErr().code,
    "syntax",
  );
  assert.equal(
    extract(
      "a.ts",
      "const a = `x ${secret}`",
      variable("a", "template", ["raw expression!"]),
    ).isErr(),
    true,
  );
});

test("joined static runs survive paragraph edits with the same selector", () => {
  const source = 'const aux = ["first", "second", dynamic.value, "last"].join("\\n\\n"); // rest';
  const selector = variable("aux", "joined-array", ["context"]);
  const prompt = extract("a.ts", source, selector)._unsafeUnwrap();
  assert.equal(prompt.content, "first\n\nsecond\n\n{{context}}\n\nlast");
  const edited = "new\nprose ${literal}\n\n{{context}}\n\nlast";
  const changed = prompt.replace(edited)._unsafeUnwrap();
  assert.equal(
    changed,
    'const aux = ["new\\nprose ${literal}", dynamic.value, "last"].join("\\n\\n"); // rest',
  );
  assert.equal(extract("a.ts", changed, selector)._unsafeUnwrap().content, edited);
});

test("joined prompts expose dynamic items as friendly placeholders and preserve expressions", () => {
  const source = 'const aux = ["first", "second", dynamic({x: 1}), "last", other].join("\\n");';
  const selector = variable("aux", "joined-array", ["context", "suffix"]);
  const prompt = extract("a.ts", source, selector)._unsafeUnwrap();
  assert.equal(prompt.content, "first\nsecond\n{{context}}\nlast\n{{suffix}}");
  const changed = prompt.replace("edited\n{{context}}\nnew last\n{{suffix}}")._unsafeUnwrap();
  assert.ok(changed.includes("dynamic({x: 1})"));
  assert.ok(changed.includes("other"));
  assert.equal(
    extract("a.ts", changed, selector)._unsafeUnwrap().content,
    "edited\n{{context}}\nnew last\n{{suffix}}",
  );
});

test("markdown body and scalar skill description preserve other frontmatter", () => {
  const source =
    "---\nname: example\ndescription: Use &lt;tools&gt; carefully.\nother: untouched\n---\n# Body\nInstructions.\n";
  const body = extract("SKILL.md", source, { kind: "markdown-body" })._unsafeUnwrap();
  assert.equal(body.content, "# Body\nInstructions.\n");
  assert.equal(
    body.replace("New body\n")._unsafeUnwrap(),
    source.replace("# Body\nInstructions.\n", "New body\n"),
  );
  const description = extract("SKILL.md", source, {
    kind: "frontmatter-description",
  })._unsafeUnwrap();
  assert.equal(description.content, "Use &lt;tools&gt; carefully.");
  const edited = 'Use "tools"\ncarefully.';
  const changed = description.replace(edited)._unsafeUnwrap();
  assert.equal(changed, source.replace("Use &lt;tools&gt; carefully.", JSON.stringify(edited)));
  assert.equal(
    extract("SKILL.md", changed, { kind: "frontmatter-description" })._unsafeUnwrap().content,
    edited,
  );
  assert.equal(
    extract("x.md", "---\ndescription: |\n  secret\n---\nbody", {
      kind: "frontmatter-description",
    }).isErr(),
    true,
  );
  assert.equal(extract("x.md", source, { kind: "markdown" })._unsafeUnwrap().content, source);
});

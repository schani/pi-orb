import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("study lifecycle closes after callback failure and allocates distinct owned outputs", async () => {
  const source = (await readFile(new URL("./study-browser.mjs", import.meta.url), "utf8"))
    .replace('import { chromium } from "playwright";', "const { chromium } = globalThis.studyFixture;");
  assert.match(source, /^const \{ chromium \} = globalThis.studyFixture;$/m);
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*["']playwright["']/);
  const root = await mkdtemp(join(tmpdir(), "study-browser-test-"));
  const previous = process.env.STUDY_OUTPUT_DIR;
  process.env.STUDY_OUTPUT_DIR = root;
  let closed = 0;
  globalThis.studyFixture = { chromium: { launch: async (options) => {
    assert(options.executablePath);
    return { close: async () => { closed++; } };
  } } };
  try {
    assert.equal(typeof globalThis.studyFixture.chromium.launch, "function");
    const { runStudy } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const outputs = [];
    for (let i = 0; i < 2; i++) {
      await assert.rejects(runStudy("fixture", async ({ artifact, outputDir }) => {
        outputs.push(outputDir);
        assert.equal(artifact("shot.png"), join(outputDir, "shot.png"));
        assert.throws(() => artifact("../escape.png"));
        throw Error("controlled assertion");
      }), /controlled assertion/);
    }
    assert.equal(closed, 2);
    assert.notEqual(outputs[0], outputs[1]);
  } finally {
    if (previous === undefined) delete process.env.STUDY_OUTPUT_DIR;
    else process.env.STUDY_OUTPUT_DIR = previous;
    delete globalThis.studyFixture;
    await rm(root, { recursive: true, force: true });
  }
});

test("all fourteen validators use owned lifecycle/output without changing study assertions", async () => {
  const files = (await readdir(new URL("./", import.meta.url))).filter((name) => name.endsWith(".smoke.mjs"));
  files.push("all-projects-research/verify.mjs");
  assert.equal(files.length, 14);
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /await runStudy\(/, file);
    assert.doesNotMatch(source, /chromium.launch|browser.close\(|\/tmp\//, file);
    let entered = false;
    globalThis.studyValidator = async (_name, run) => {
      entered = true;
      return run({ browser: { newPage: async () => { throw Error("controlled page creation"); }, newContext: async () => { throw Error("controlled page creation"); } } });
    };
    const executable = source
      .replace(/^import \{ runStudy \} from .*;$/m, "const runStudy = globalThis.studyValidator;")
      .replace(/^import \{ expect \} from .*;$/m, "const expect = undefined;")
      .replaceAll("import.meta.url", JSON.stringify(new URL(file, import.meta.url).href));
    assert.match(executable, /^const runStudy = globalThis.studyValidator;$/m);
    assert.doesNotMatch(executable, /(?:from\s*|import\s*\()\s*["'][^"']*(?:study-browser|playwright)/);
    assert.equal(typeof globalThis.studyValidator, "function");
    try {
      await assert.rejects(import("data:text/javascript;base64," + Buffer.from(executable).toString("base64")), /controlled page creation/);
      assert(entered, file);
    } finally { delete globalThis.studyValidator; }
  }
});

// Run from /app in the built candidate image; no mounts or network credentials required.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { okAsync, ResultAsync } from "neverthrow";
import { loadPlatformResources } from "./apps/control-plane/src/adapters/durable/platform-resources.ts";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_CONCURRENCY,
} from "./apps/control-plane/src/adapters/durable/tools/callback-limits.js";
import { CallableCatalog } from "./apps/control-plane/src/adapters/durable/tools/catalog.ts";
import { codemodeTool } from "./apps/control-plane/src/adapters/durable/tools/codemode.ts";
import { GitResourceSource } from "./apps/control-plane/src/adapters/git-resources/git.ts";

/** @template T @param {"open" | "root" | "resume" | "submit" | "wait" | "close"} operation @param {() => Promise<T>} run */
const native = (operation, run) =>
  ResultAsync.fromThrowable(run, () => ({ code: "image_proof_native_failed", operation }))();
const diagnostics = (result) =>
  JSON.stringify({
    output: result.output?.filter((block) => block.type === "text"),
    diagnostics: result.diagnostics,
  });

for (const file of ["bounded-worker.js", "callback-limits.js", "callback-limits.d.ts"])
  assert(existsSync(`./apps/control-plane/src/adapters/durable/tools/${file}`), file);
const skills = (await loadPlatformResources("./apps/orb-runtime/skills"))._unsafeUnwrap();
assert(skills.length > 0);
assert(skills.some((file) => file.path.endsWith("/SKILL.md")));
const repo = mkdtempSync("/tmp/cp-image-git-");
let harness;
try {
  execFileSync("git", ["init", "-b", "main", repo]);
  writeFileSync(join(repo, "AGENTS.md"), "IMAGE_GIT_INSTRUCTIONS\n");
  execFileSync("git", ["-C", repo, "add", "AGENTS.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Image fixture",
    "-c",
    "user.email=image@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const pin = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const snapshot = (
    await new GitResourceSource({ environment: () => okAsync({}) }, true).acquire({
      orbId: "image-fixture",
      url: pathToFileURL(repo).href,
      signal: new AbortController().signal,
    })
  )._unsafeUnwrap();
  assert.equal(snapshot.commitSha, pin);
  assert(
    snapshot.files.some(
      (file) =>
        file.path === "AGENTS.md" &&
        Buffer.from(file.bytes).toString() === "IMAGE_GIT_INSTRUCTIONS\n",
    ),
  );
  const png = Buffer.alloc(20 * 1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const catalog = new CallableCatalog([
    defineTool({
      name: "picture",
      description: "picture",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "image", data, mimeType: "image/png" }] }),
    }),
  ]);
  const tool = codemodeTool(catalog, new Set());
  let calls = [];
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "image-proof",
      tools: [
        ...catalog.registrations(),
        defineTool({
          ...tool,
          execute: async (args, api, context) => {
            const call = {
              source: args.code,
              callId: api.callId,
              taskId: api.taskId,
              conversationId: api.conversationId,
            };
            calls.push(call);
            call.result = await tool.execute(args, api, context);
            return call.result;
          },
        }),
      ],
    }),
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const opened = await native("open", () =>
    Harness.open(new MemoryStorage(), { models, registry }, ctx),
  );
  assert(opened.isOk(), JSON.stringify(opened.isErr() ? opened.error : undefined));
  harness = opened.value;
  const rooted = await native("root", () =>
    harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } }),
  );
  assert(rooted.isOk(), JSON.stringify(rooted.isErr() ? rooted.error : undefined));
  const root = rooted.value;
  const resumed = await native("resume", async () => harness.resume());
  assert(resumed.isOk(), JSON.stringify(resumed.isErr() ? resumed.error : undefined));
  const taskIds = new Set();
  async function run(source) {
    calls = [];
    const callId = `image-proof-${taskIds.size + 1}`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: source }, { id: callId }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const submitted = await native("submit", () =>
      root.submit({ type: "input", content: "run" }, ctx),
    );
    assert(submitted.isOk(), JSON.stringify(submitted.isErr() ? submitted.error : undefined));
    const settled = await native("wait", () => submitted.value.wait(ctx));
    assert(settled.isOk(), JSON.stringify(settled.isErr() ? settled.error : undefined));
    assert.equal(settled.value.status, "done", "Native submission did not complete");
    assert.equal(calls.length, 1, "Expected one executed native code-mode call");
    const call = calls[0];
    assert.equal(call.source, source, "Native source mismatch");
    assert.equal(call.callId, callId, "Native call ID mismatch");
    assert.equal(call.conversationId, root.id, "Native conversation mismatch");
    assert.equal(typeof call.taskId, "string", "Missing native task ID");
    assert(call.taskId.length > 0 && !taskIds.has(call.taskId), "Repeated native task ID");
    taskIds.add(call.taskId);
    assert(call.result, "Native code-mode call did not return a result");
    return call.result;
  }
  const result = await run('image((await tools.picture({}))[0]); store("passed",true);');
  assert.equal(result.isError, false, diagnostics(result));
  const images = result.output.filter((block) => block.type === "image");
  assert.equal(images.length, 1, diagnostics(result));
  assert.equal(images[0].data === data, true, diagnostics(result));
  assert.equal(images[0].mimeType, "image/png", diagnostics(result));
  const saved = await run('text(load("passed"));');
  assert.equal(saved.isError, false, diagnostics(saved));
  assert(
    saved.output.some((block) => block.type === "text" && block.text === "true"),
    diagnostics(saved),
  );
  const limited = await run(
    `store("failed",true); await Promise.all(Array.from({length:${MAX_CALLBACK_CONCURRENCY + 1}},()=>describeNamespace("fixture")));`,
  );
  assert.equal(limited.isError, true, diagnostics(limited));
  assert(
    limited.output.some(
      (block) => block.type === "text" && block.text.includes(CALLBACK_LIMIT_MESSAGE),
    ),
    diagnostics(limited),
  );
  const rolledBack = await run('text(load("failed")===undefined);');
  assert.equal(rolledBack.isError, false, diagnostics(rolledBack));
  assert(
    rolledBack.output.some((block) => block.type === "text" && block.text === "true"),
    diagnostics(rolledBack),
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      gitPin: pin,
      bundledSkills: skills.length,
      imageBytes: png.length,
      imageSha256: createHash("sha256").update(png).digest("hex"),
      worker: "production bounded-worker.js",
      callbackConcurrency: MAX_CALLBACK_CONCURRENCY,
      failedStoreRollback: true,
    }),
  );
} finally {
  if (harness) {
    const closed = await native("close", () => harness.close(ctx));
    assert(closed.isOk(), JSON.stringify(closed.isErr() ? closed.error : undefined));
  }
  rmSync(repo, { recursive: true, force: true });
}

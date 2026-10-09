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
import { createRegistry, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { loadPlatformResources } from "./apps/control-plane/src/adapters/durable/platform-resources.ts";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_CONCURRENCY,
} from "./apps/control-plane/src/adapters/durable/tools/callback-limits.js";
import { CallableCatalog } from "./apps/control-plane/src/adapters/durable/tools/catalog.ts";
import { codemodeTool } from "./apps/control-plane/src/adapters/durable/tools/codemode.ts";
import { GitResourceSource } from "./apps/control-plane/src/adapters/git-resources/git.ts";

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
  harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const root = await harness.root(ctx);
  const api = { conversationId: root.id, commit: root.commit.bind(root), callId: "image-proof" };
  const png = Buffer.alloc(20 * 1024 * 1024, 97);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const data = png.toString("base64");
  const tool = codemodeTool(
    new CallableCatalog([
      defineTool({
        name: "picture",
        description: "picture",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
      }),
    ]),
    new Set(),
  );
  const result = await tool.execute(
    { code: 'image((await tools.picture({}))[0]); store("passed",true);' },
    api,
    ctx,
  );
  assert.equal(
    result.isError,
    false,
    JSON.stringify(result.content?.filter((block) => block.type === "text")),
  );
  const images = result.content.filter((block) => block.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0].data, data);
  assert.equal(images[0].mimeType, "image/png");
  const saved = await tool.execute({ code: 'text(load("passed"));' }, api, ctx);
  assert(saved.content.some((block) => block.type === "text" && block.text === "true"));
  const limited = await tool.execute(
    {
      code: `store("failed",true); await Promise.all(Array.from({length:${MAX_CALLBACK_CONCURRENCY + 1}},()=>describeNamespace("fixture")));`,
    },
    api,
    ctx,
  );
  assert.equal(limited.isError, true);
  assert(JSON.stringify(limited.content).includes(CALLBACK_LIMIT_MESSAGE));
  const rolledBack = await tool.execute({ code: 'text(load("failed")===undefined);' }, api, ctx);
  assert(rolledBack.content.some((block) => block.type === "text" && block.text === "true"));
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
  if (harness) await harness.close(ctx);
  rmSync(repo, { recursive: true, force: true });
}

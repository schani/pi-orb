import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { type ResourceError, resourceError } from "../../domain/resources.ts";
import type { OwnerSkillBundle } from "./owner-skill-bundle.ts";

const installer = String.raw`
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const [root, stage, phase] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(path.join(stage, ".manifest.json"), "utf8"));
function valid(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return false;
    const seen = [];
    function walk(base) {
      for (const name of fs.readdirSync(path.join(dir, base))) {
        const rel = path.join(base, name), stat = fs.lstatSync(path.join(dir, rel));
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) { if (!walk(rel)) return false; }
        else if (stat.isFile()) seen.push(rel);
        else return false;
      }
      return true;
    }
    if (!walk("") || seen.length !== manifest.length) return false;
    return manifest.every(f => {
      const file = path.join(dir, f.path), stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 511) === (f.executable ? 448 : 384) &&
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === f.sha256;
    });
  } catch { return false; }
}
if (phase === "verify") {
  process.stdout.write(valid(root) ? "verified" : fs.existsSync(root) ? "corrupt" : "missing");
} else {
  fs.unlinkSync(path.join(stage, ".manifest.json"));
  for (const f of manifest) fs.chmodSync(path.join(stage, f.path), f.executable ? 448 : 384);
  if (!valid(stage)) process.exit(2);
  if (fs.existsSync(root)) {
    if (!valid(root)) process.exit(3);
    process.stdout.write("verified");
  } else {
    try { fs.renameSync(stage, root); process.stdout.write("installed"); }
    catch (e) { if (!valid(root)) throw e; process.stdout.write("verified"); }
  }
}
`;

/** Every binding installs the captured context, including replacement hosts. No imported code runs. */
export function installOwnerSkills(
  env: ExecutionEnv,
  bundle: OwnerSkillBundle,
  context: Context,
  checkpoint: () => Promise<void | Result<void, ResourceError>> = async () => {},
): ResultAsync<"verified" | "installed", ResourceError> {
  if (bundle.files.length === 0) return okAsync("verified" as const);
  const stage = `${bundle.root}.stage-${randomUUID()}`;
  const failure = () => resourceError("storage", `Cannot install owner skills at ${bundle.root}.`);
  return ResultAsync.fromPromise(
    (async (): Promise<Result<"verified" | "installed", ResourceError>> => {
      const runInstall = async (): Promise<Result<"verified" | "installed", ResourceError>> => {
        const parents = posix.dirname(bundle.root).split("/");
        let parent = bundle.root.startsWith("/") ? "/" : "";
        for (const part of parents.filter(Boolean)) {
          parent = posix.join(parent, part);
          const info = await env.fileInfo(parent, context);
          if (info.ok ? info.value.kind !== "directory" : info.error.code !== "not_found")
            return err(failure());
          if (!info.ok && !(await env.createDir(parent, { recursive: false }, context)).ok) {
            const raced = await env.fileInfo(parent, context);
            if (!raced.ok || raced.value.kind !== "directory") return err(failure());
          }
        }
        const made = await env.createDir(stage, { recursive: false }, context);
        if (!made.ok) return err(failure());
        const manifest = bundle.files.map((f) => ({
          path: posix.relative(bundle.root, f.path),
          sha256: f.sha256,
          executable: f.executable,
        }));
        const manifestBytes = Buffer.from(JSON.stringify(manifest));
        const chunkBytes = 4 * 1024 * 1024;
        for (let offset = 0; offset < manifestBytes.byteLength; offset += chunkBytes) {
          const chunk = manifestBytes.subarray(offset, offset + chunkBytes);
          const written =
            offset === 0
              ? await env.writeFile(`${stage}/.manifest.json`, chunk, context)
              : await env.appendFile(`${stage}/.manifest.json`, chunk, context);
          if (!written.ok) return err(failure());
        }
        const run = async (phase: string) => {
          let output = "";
          const value = await env.exec(
            ["node", "-e", installer, bundle.root, stage, phase],
            {
              onOutput: (text) => {
                output += text;
              },
            },
            context,
          );
          return value.ok && value.value.exitCode === 0 ? output.trim() : null;
        };
        const existing = await run("verify");
        if (existing === "verified") return ok("verified" as const);
        if (existing !== "missing") return err(failure());
        for (const file of bundle.files) {
          const target = `${stage}/${posix.relative(bundle.root, file.path)}`;
          if (
            !(await env.createDir(posix.dirname(target), { recursive: true }, context)).ok ||
            !(await env.writeFile(target, file.bytes, context)).ok
          )
            return err(failure());
        }
        const admitted = await checkpoint();
        if (admitted?.isErr()) return err(admitted.error);
        if (context.abortSignal?.aborted) return err(failure());
        const outcome = await run("publish");
        return outcome === "verified" || outcome === "installed" ? ok(outcome) : err(failure());
      };
      const installed = await ResultAsync.fromPromise(runInstall(), failure).andThen((r) => r);
      const cleaned = await ResultAsync.fromPromise(
        env.remove(stage, { recursive: true, force: true }, withoutAbortSignal(context)),
        failure,
      );
      return installed.isErr()
        ? installed
        : cleaned.isErr() || !cleaned.value.ok
          ? err(failure())
          : installed;
    })(),
    failure,
  ).andThen((r) => r);
}

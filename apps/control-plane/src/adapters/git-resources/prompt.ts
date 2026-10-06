import { posix } from "node:path";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { err, ok, Result } from "neverthrow";
import {
  type ResourceError,
  type ResourceSnapshot,
  resourceError,
} from "../../domain/resources.ts";
export function snapshotPromptResources(
  snapshot: ResourceSnapshot,
): Result<
  { instructions: Array<{ path: string; content: string }>; skills: Skill[] },
  ResourceError
> {
  const instructions: Array<{ path: string; content: string }> = [];
  const skills: Skill[] = [];
  const decode = (bytes: Uint8Array) =>
    Result.fromThrowable(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      () => resourceError("invalid", "Invalid resource text encoding"),
    )();
  if (snapshot.instructionPath) {
    const file = snapshot.files.find((file) => file.path === snapshot.instructionPath);
    if (!file) return err(resourceError("invalid", "Required instruction resource missing"));
    const content = decode(file.bytes);
    if (content.isErr()) return err(content.error);
    instructions.push({ path: file.path, content: content.value });
  }
  if (!snapshot.skillRoot) return ok({ instructions, skills });
  const root = snapshot.skillRoot;
  const prefix = root + "/";
  const roots = new Set(
    snapshot.files
      .filter((file) => file.path.startsWith(prefix) && posix.basename(file.path) === "SKILL.md")
      .map((file) => posix.dirname(file.path)),
  );
  const names = new Set<string>();
  for (const file of snapshot.files) {
    if (!file.path.startsWith(prefix)) continue;
    const dir = posix.dirname(file.path);
    let parent = dir;
    let nested = false;
    while (parent !== "." && parent.startsWith(root)) {
      if (parent !== dir && roots.has(parent)) {
        nested = true;
        break;
      }
      parent = posix.dirname(parent);
    }
    if (nested) continue;
    const isSkill = posix.basename(file.path) === "SKILL.md";
    if (!isSkill && !(dir === root && file.path.endsWith(".md") && !roots.has(root))) continue;
    const text = decode(file.bytes);
    if (text.isErr()) return err(text.error);
    const parsed = Result.fromThrowable(
      () => parseFrontmatter(text.value),
      () => resourceError("invalid", "Invalid skill metadata"),
    )();
    if (parsed.isErr()) return err(parsed.error);
    const meta = parsed.value.frontmatter;
    const name = meta.name ?? (isSkill ? posix.basename(dir) : posix.basename(file.path, ".md"));
    if (
      typeof name !== "string" ||
      !name ||
      typeof meta.description !== "string" ||
      !meta.description.trim() ||
      names.has(name)
    )
      return err(resourceError("invalid", "Invalid or duplicate skill metadata"));
    names.add(name);
    skills.push({
      name,
      description: meta.description,
      filePath: file.path,
      baseDir: dir,
      sourceInfo: {
        path: file.path,
        source: "repository",
        scope: "project",
        origin: "top-level",
        baseDir: dir,
      },
      disableModelInvocation: meta["disable-model-invocation"] === true,
    });
  }
  return ok({ instructions, skills });
}

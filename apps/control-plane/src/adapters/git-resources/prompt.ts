import { posix } from "node:path";
import { parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { ResourceWarning } from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import {
  type ResourceError,
  type ResourceSnapshot,
  resourceError,
} from "../../domain/resources.ts";

/** Keep the complete JSON path inside resourceError's diagnostic budget. */
function promptError(reason: string, path: string): ResourceError {
  const prefix = reason + ": ";
  let bounded = path.slice(0, 1024);
  const encodePath = (value: string) =>
    JSON.stringify(value).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  let encoded = encodePath(bounded);
  while (prefix.length + encoded.length > 1536) {
    bounded = bounded.slice(0, -1);
    encoded = encodePath(bounded);
  }
  return resourceError("invalid", prefix + encoded);
}

const skillReasons: Record<ResourceWarning["code"], string> = {
  invalid_utf8: "Invalid resource text encoding",
  invalid_yaml: "Invalid skill YAML",
  invalid_metadata: "Invalid skill metadata",
  duplicate_name: "Duplicate skill name",
};

export function snapshotPromptResources(
  snapshot: Pick<ResourceSnapshot, "instructionPath" | "skillRoot" | "files">,
  options: { invalidSkills?: "strict" | "warn" } = {},
): Result<
  {
    instructions: Array<{ path: string; content: string }>;
    skills: Skill[];
    warnings: ResourceWarning[];
  },
  ResourceError
> {
  const instructions: Array<{ path: string; content: string }> = [];
  const skills: Skill[] = [];
  const warnings: ResourceWarning[] = [];
  const invalidSkill = (path: string, code: ResourceWarning["code"]) => {
    if (options.invalidSkills === "warn") {
      warnings.push({ path, code });
      return null;
    }
    return promptError(skillReasons[code], path);
  };
  const decode = (bytes: Uint8Array, path: string) =>
    Result.fromThrowable(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      () => promptError(skillReasons.invalid_utf8, path),
    )();
  if (snapshot.instructionPath) {
    const file = snapshot.files.find((file) => file.path === snapshot.instructionPath);
    if (!file)
      return err(promptError("Required instruction resource missing", snapshot.instructionPath));
    const content = decode(file.bytes, file.path);
    if (content.isErr()) return err(content.error);
    instructions.push({ path: file.path, content: content.value });
  }
  if (!snapshot.skillRoot) return ok({ instructions, skills, warnings });
  const root = snapshot.skillRoot;
  const prefix = root + "/";
  const roots = new Set(
    snapshot.files
      .filter((file) => file.path.startsWith(prefix) && posix.basename(file.path) === "SKILL.md")
      .map((file) => posix.dirname(file.path)),
  );
  const names = new Set<string>();
  const files = [...snapshot.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const file of files) {
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
    const text = decode(file.bytes, file.path);
    if (text.isErr()) {
      const failure = invalidSkill(file.path, "invalid_utf8");
      if (failure) return err(failure);
      continue;
    }
    const parsed = Result.fromThrowable(
      () => parseFrontmatter(text.value),
      () => undefined,
    )();
    if (parsed.isErr()) {
      const failure = invalidSkill(file.path, "invalid_yaml");
      if (failure) return err(failure);
      continue;
    }
    const meta = parsed.value.frontmatter;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      const failure = invalidSkill(file.path, "invalid_metadata");
      if (failure) return err(failure);
      continue;
    }
    const name = meta.name ?? (isSkill ? posix.basename(dir) : posix.basename(file.path, ".md"));
    if (
      typeof name !== "string" ||
      !name ||
      typeof meta.description !== "string" ||
      !meta.description.trim()
    ) {
      const failure = invalidSkill(file.path, "invalid_metadata");
      if (failure) return err(failure);
      continue;
    }
    if (names.has(name)) {
      const failure = invalidSkill(file.path, "duplicate_name");
      if (failure) return err(failure);
      continue;
    }
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
  return ok({ instructions, skills, warnings });
}

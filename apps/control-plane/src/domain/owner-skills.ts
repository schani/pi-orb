import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  ImportOwnerSkillRequestSchema,
  OWNER_SKILL_BUNDLE_MAX_BYTES,
  OWNER_SKILL_BUNDLE_MAX_FILES,
  OWNER_SKILL_MAX_BYTES,
  OWNER_SKILL_MAX_COUNT,
  OWNER_SKILL_MAX_DESCRIPTION,
  OWNER_SKILL_NAME_PATTERN,
  OWNER_SKILL_PATH_MAX_BYTES,
  OWNER_SKILLS_MAX_BYTES,
  OWNER_SKILLS_MAX_JSON_BYTES,
  type OwnerSkillFile,
  OwnerSkillFileSchema,
  type OwnerSkillList,
  type OwnerSkillPreview,
  type OwnerSkillSourceMetadata,
  OwnerSkillSourceMetadataSchema,
  type OwnerSkillsSnapshot,
  PreviewOwnerSkillRequestSchema,
  WriteOwnerSkillRequestSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

/** Owner skills apply to every orb of every project the owner has (docs/owner-skills-secrets.md). */
export interface OwnerSkillError {
  readonly type: "owner_skill_error";
  readonly code: "invalid" | "not_found" | "conflict" | "unavailable" | "internal";
  readonly message: string;
}
export const ownerSkillError = (
  code: OwnerSkillError["code"],
  message: string,
): OwnerSkillError => ({ type: "owner_skill_error", code, message });
export interface OwnerSkillBundle {
  readonly content: string;
  readonly files: OwnerSkillFile[];
  readonly source: OwnerSkillSourceMetadata | null;
}
/** Acquisition is bounded and cancellable; an explicit SHA never resolves the URL's mutable ref. */
export interface OwnerSkillSource {
  acquire(
    task: SimulationTask,
    request: { readonly url: string; readonly commitSha?: string },
    signal?: AbortSignal,
  ): ResultAsync<OwnerSkillBundle, OwnerSkillError>;
}
export interface OwnerSkillRecord extends OwnerSkillBundle {
  readonly name: string;
  readonly updatedAt: string;
}
type OwnerSkillWrite = { readonly name: string; readonly content: string };
type OwnerSkillCreate = OwnerSkillWrite & OwnerSkillBundle;
type Records = ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
/** `replace` renames when `skill.name` differs from `name`. */
export type OwnerSkillCommand =
  | { readonly kind: "create"; readonly skill: OwnerSkillCreate }
  | { readonly kind: "replace"; readonly name: string; readonly skill: OwnerSkillWrite }
  | { readonly kind: "delete"; readonly name: string };
/** `apply` is atomic per user (applyOwnerSkillCommand); both return the full set sorted by name. */
export interface OwnerSkillStore {
  list(task: SimulationTask, userId: string): Records;
  /** Import cancellation is honored under the owner lock through the pre-commit boundary. */
  apply(
    task: SimulationTask,
    userId: string,
    command: OwnerSkillCommand,
    signal?: AbortSignal,
  ): Records;
}
export interface OwnerSkillsDeps {
  readonly store: OwnerSkillStore;
  readonly source: OwnerSkillSource;
  /** Bundled platform skill names; owner skills may not take them. */
  readonly platformSkillNames: ReadonlySet<string>;
}

const invalid = (message: string) => ownerSkillError("invalid", message);

/** The per-user rule every store applies under its lock: unique names, a count cap on create. */
export function applyOwnerSkillCommand(
  current: readonly OwnerSkillRecord[],
  command: OwnerSkillCommand,
  updatedAt: string,
): Result<OwnerSkillRecord[], OwnerSkillError> {
  const has = (name: string) => current.some((item) => item.name === name);
  const target = command.kind === "create" ? null : command.name;
  if (target !== null && !has(target))
    return err(ownerSkillError("not_found", `Skill "${target}" doesn't exist`));
  if (command.kind !== "delete" && command.skill.name !== target && has(command.skill.name))
    return err(ownerSkillError("conflict", `Skill "${command.skill.name}" already exists`));
  if (command.kind === "create" && current.length >= OWNER_SKILL_MAX_COUNT)
    return err(ownerSkillError("conflict", `At most ${OWNER_SKILL_MAX_COUNT} skills`));
  const kept = current.filter((item) => item.name !== target);
  const next =
    command.kind === "delete"
      ? kept
      : command.kind === "create"
        ? [...kept, { ...command.skill, updatedAt }]
        : current.map((item) =>
            item.name === command.name ? { ...item, ...command.skill, updatedAt } : item,
          );
  if (command.kind !== "delete") {
    const changed = next.find((item) => item.name === command.skill.name);
    if (changed && bundleBytes(changed) > OWNER_SKILL_BUNDLE_MAX_BYTES)
      return err(invalid("Skill bundle must be at most 8 MiB"));
    const decoded = next.reduce((total, item) => total + bundleBytes(item), 0);
    if (decoded > OWNER_SKILLS_MAX_BYTES)
      return err(ownerSkillError("conflict", "Owner skills must total at most 16 MiB"));
    if (Buffer.byteLength(JSON.stringify(snapshot(next))) > OWNER_SKILLS_MAX_JSON_BYTES)
      return err(ownerSkillError("conflict", "Owner skill snapshots must be at most 24 MiB JSON"));
  }
  return ok(next.sort((a, b) => (a.name < b.name ? -1 : 1)));
}
const namePattern = new RegExp(OWNER_SKILL_NAME_PATTERN);
const parseYaml = Result.fromThrowable(parseFrontmatter, () => invalid("Invalid skill YAML"));

/** Accepts exactly what Pi's skill loader accepts, plus the Agent Skills name rule. */
function parseOwnerSkill(
  body: unknown,
): Result<{ name: string; description: string; content: string }, OwnerSkillError> {
  if (!Check(WriteOwnerSkillRequestSchema, body)) return err(invalid("Expected {content: string}"));
  const { content } = body;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content))
    return err(invalid("Skill must be valid Unicode"));
  if (new TextEncoder().encode(content).length > OWNER_SKILL_MAX_BYTES)
    return err(invalid("Skill must be at most 64 KiB"));
  return parseYaml(content).andThen(({ frontmatter: meta }) => {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta))
      return err(invalid("Skill frontmatter needs a name and a description"));
    const { name, description } = meta;
    if (typeof name !== "string" || !namePattern.test(name))
      return err(invalid("Skill name must be 1–64 lowercase letters, digits and single hyphens"));
    if (typeof description !== "string" || !description.trim())
      return err(invalid("Skill description is required"));
    if (description.length > OWNER_SKILL_MAX_DESCRIPTION)
      return err(invalid("Skill description must be at most 1024 characters"));
    return ok({ name, description, content });
  });
}

/** The browser view of a command's result: every skill with its parsed description. */
export function describeOwnerSkills(
  records: Records,
): ResultAsync<OwnerSkillList, OwnerSkillError> {
  const describe = (record: OwnerSkillRecord) =>
    parseOwnerSkill({ content: record.content }).andThen(({ name, description }) =>
      name === record.name
        ? ok({
            name,
            description,
            content: record.content,
            updatedAt: record.updatedAt,
            source: record.source,
            fileCount: record.files.length + 1,
            totalBytes: bundleBytes(record),
          })
        : err(invalid("")),
    );
  return records.andThen((items) =>
    Result.combine(items.map(describe))
      .map((described) => ({ items: described }))
      .mapErr(() => ownerSkillError("internal", "Owner skill storage is inconsistent")),
  );
}

/** Validates a create (`name` null) or replace body, then applies it under the user's lock. */
export const writeOwnerSkill = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  userId: string,
  name: string | null,
  body: unknown,
) =>
  describeOwnerSkills(
    parseOwnerSkill(body)
      .andThen(({ name: skillName, content }) =>
        deps.platformSkillNames.has(skillName)
          ? err(invalid(`"${skillName}" is a bundled platform skill`))
          : ok({ name: skillName, content }),
      )
      .asyncAndThen((skill) =>
        deps.store.apply(
          task,
          userId,
          name === null
            ? { kind: "create", skill: { ...skill, files: [], source: null } }
            : { kind: "replace", name, skill },
        ),
      ),
  );

/** Every context captures the complete stored bundle, without further acquisition. */
export const readOwnerSkillsSnapshot = (
  task: SimulationTask,
  store: OwnerSkillStore,
  userId: string,
): ResultAsync<OwnerSkillsSnapshot, OwnerSkillError> => store.list(task, userId).map(snapshot);

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const bundleBytes = (bundle: OwnerSkillBundle) =>
  byteLength(bundle.content) +
  bundle.files.reduce((total, file) => total + Buffer.byteLength(file.base64, "base64"), 0);
const snapshot = (records: readonly OwnerSkillRecord[]): OwnerSkillsSnapshot => ({
  skills: records.map(({ name, content, files, source }) => ({ name, content, files, source })),
});
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Defense in depth at the acquisition boundary, before any owner mutation. */
export function validateOwnerSkillBundle(
  bundle: OwnerSkillBundle,
): Result<OwnerSkillPreview, OwnerSkillError> {
  const parsed = parseOwnerSkill({ content: bundle.content });
  if (parsed.isErr()) return err(parsed.error);
  if (bundle.source === null || !Check(OwnerSkillSourceMetadataSchema, bundle.source))
    return err(invalid("Imported skill needs a GitHub URL and full commit SHA"));
  if (bundle.files.length + 1 > OWNER_SKILL_BUNDLE_MAX_FILES)
    return err(invalid("Skill bundle must contain at most 5,000 files"));
  const paths = new Set(["SKILL.md"]);
  let totalBytes = byteLength(bundle.content);
  const manifest = [{ path: "SKILL.md", bytes: totalBytes, executable: false }];
  for (const file of bundle.files) {
    if (!Check(OwnerSkillFileSchema, file)) return err(invalid("Invalid support file"));
    const { path, base64, executable } = file;
    if (
      byteLength(path) > OWNER_SKILL_PATH_MAX_BYTES ||
      invalidUnicode.test(path) ||
      path.includes("\\") ||
      [...path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      return err(invalid("Support file paths must be normalized relative UTF-8 paths"));
    if (paths.has(path)) return err(invalid("Duplicate or conflicting skill paths"));
    if (
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
      Buffer.from(base64, "base64").toString("base64") !== base64
    )
      return err(invalid("Support file bytes must be canonical base64"));
    const bytes = Buffer.byteLength(base64, "base64");
    totalBytes += bytes;
    if (totalBytes > OWNER_SKILL_BUNDLE_MAX_BYTES)
      return err(invalid("Skill bundle must be at most 8 MiB"));
    paths.add(path);
    manifest.push({ path, bytes, executable });
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/")))
        return err(invalid("Duplicate or conflicting skill paths"));
  }
  return ok({
    ...parsed.value,
    source: bundle.source,
    manifest,
    fileCount: manifest.length,
    totalBytes,
  });
}

const acquired = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  request: { url: string; commitSha?: string },
  signal?: AbortSignal,
) =>
  deps.source.acquire(task, request, signal).andThen((bundle) =>
    validateOwnerSkillBundle(bundle).andThen((preview) => {
      if (signal?.aborted) return err(ownerSkillError("unavailable", "Skill import cancelled"));
      if (
        preview.source.url !== request.url ||
        (request.commitSha !== undefined && preview.source.commitSha !== request.commitSha)
      )
        return err(invalid("Acquired skill does not match the requested source pin"));
      if (deps.platformSkillNames.has(preview.name))
        return err(invalid(`"${preview.name}" is a bundled platform skill`));
      return ok({ bundle, preview });
    }),
  );

export const previewOwnerSkill = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  body: unknown,
  signal?: AbortSignal,
): ResultAsync<OwnerSkillPreview, OwnerSkillError> =>
  (Check(PreviewOwnerSkillRequestSchema, body) ? ok(body) : err(invalid("Expected {url: string}")))
    .asyncAndThen((request) => acquired(task, deps, request, signal))
    .map(({ preview }) => preview);

export const importOwnerSkill = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  userId: string,
  body: unknown,
  signal?: AbortSignal,
): ResultAsync<OwnerSkillList, OwnerSkillError> =>
  describeOwnerSkills(
    (Check(ImportOwnerSkillRequestSchema, body)
      ? ok(body)
      : err(invalid("Expected {url: string, commitSha: full SHA}"))
    )
      .asyncAndThen((request) => acquired(task, deps, request, signal))
      .andThen(({ bundle, preview }) =>
        deps.store.apply(
          task,
          userId,
          {
            kind: "create",
            skill: { name: preview.name, ...bundle },
          },
          signal,
        ),
      ),
  );

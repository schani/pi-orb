import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  AddOwnerSkillRequestSchema,
  OWNER_SKILL_MAX_BYTES,
  OWNER_SKILL_MAX_COUNT,
  OWNER_SKILL_MAX_DESCRIPTION,
  OWNER_SKILL_NAME_PATTERN,
  type OwnerSkillList,
  type OwnerSkillsSnapshot,
  validateOwnerSkillsSnapshot,
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
export type OwnerSkillBundle = Omit<OwnerSkillsSnapshot["skills"][number], "name">;
export interface OwnerSkillRecord extends OwnerSkillBundle {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}
type OwnerSkillWrite = {
  readonly name: string;
  readonly content: string;
  readonly files?: OwnerSkillBundle["files"];
  readonly source?: OwnerSkillBundle["source"];
};
type Records = ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
/** `replace` renames when `skill.name` differs from `name`. */
export type OwnerSkillCommand =
  | { readonly kind: "create"; readonly skill: OwnerSkillWrite }
  | { readonly kind: "replace"; readonly name: string; readonly skill: OwnerSkillWrite }
  | { readonly kind: "delete"; readonly name: string };
/** `apply` is atomic per user (applyOwnerSkillCommand); both return the full set sorted by name. */
export interface OwnerSkillStore {
  list(task: SimulationTask, userId: string): Records;
  apply(task: SimulationTask, userId: string, command: OwnerSkillCommand): Records;
}
export interface OwnerSkillsDeps {
  readonly store: OwnerSkillStore;
  readonly acquireGithub: (
    url: string,
    signal?: AbortSignal,
  ) => ResultAsync<OwnerSkillBundle, OwnerSkillError>;
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
  const previous = current.find((item) => item.name === target);
  const next =
    command.kind === "delete"
      ? kept
      : [
          ...kept,
          {
            files: previous?.files ?? [],
            source: previous?.source ?? null,
            ...command.skill,
            updatedAt,
          },
        ];
  return validateOwnerSkillsSnapshot({
    skills: next.map(({ name, content, files, source }) => ({ name, content, files, source })),
  })
    .mapErr(({ message }) => invalid(message))
    .map(() => next.sort((a, b) => (a.name < b.name ? -1 : 1)));
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
            content: record.content,
            updatedAt: record.updatedAt,
            source: record.source,
            description,
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
  signal?: AbortSignal,
) => {
  if (name === null && Check(AddOwnerSkillRequestSchema, body) && "githubUrl" in body) {
    const acquired = deps.acquireGithub(body.githubUrl, signal);
    return describeOwnerSkills(
      acquired
        .andThen((bundle) =>
          parseOwnerSkill({ content: bundle.content }).andThen(({ name: skillName }) =>
            deps.platformSkillNames.has(skillName)
              ? err(invalid(`"${skillName}" is a bundled platform skill`))
              : ok({ name: skillName, ...bundle }),
          ),
        )
        .andThen((skill) =>
          signal?.aborted
            ? err(ownerSkillError("unavailable", "GitHub import cancelled"))
            : deps.store.apply(task, userId, { kind: "create", skill }),
        ),
    );
  }
  return describeOwnerSkills(
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
          name === null ? { kind: "create", skill } : { kind: "replace", name, skill },
        ),
      ),
  );
};

/** What an agent context adopts at open: names and raw `SKILL.md` text. */
export const readOwnerSkillsSnapshot = (
  task: SimulationTask,
  store: OwnerSkillStore,
  userId: string,
): ResultAsync<OwnerSkillsSnapshot, OwnerSkillError> =>
  store.list(task, userId).andThen((records) =>
    validateOwnerSkillsSnapshot({
      skills: records.map(({ name, content, files, source }) => ({
        name,
        content,
        files,
        source,
      })),
    }).mapErr(({ message }) => invalid(message)),
  );

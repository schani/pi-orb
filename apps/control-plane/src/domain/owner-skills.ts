import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  OWNER_SKILL_MAX_BYTES,
  OWNER_SKILL_MAX_DESCRIPTION,
  OWNER_SKILL_NAME_PATTERN,
  type OwnerSkillList,
  type OwnerSkillsSnapshot,
  WriteOwnerSkillRequestSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

/** Owner skills apply to every orb of every project the owner has (docs/owner-skills-secrets.md). */
export interface OwnerSkillError {
  readonly type: "owner_skill_error";
  readonly code: "invalid" | "not_found" | "conflict" | "unavailable" | "internal";
  readonly message: string;
}
export interface OwnerSkillRecord {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}
type OwnerSkillWrite = { readonly name: string; readonly content: string };
/**
 * Every command is atomic per user and returns the user's complete set,
 * sorted by name, as of that command. `create` enforces OWNER_SKILL_MAX_COUNT.
 */
export interface OwnerSkillStore {
  list(task: SimulationTask, userId: string): ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
  create(
    task: SimulationTask,
    userId: string,
    skill: OwnerSkillWrite,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
  /** Replaces `name`; renames in the same transaction when `skill.name` differs. */
  replace(
    task: SimulationTask,
    userId: string,
    name: string,
    skill: OwnerSkillWrite,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
  delete(
    task: SimulationTask,
    userId: string,
    name: string,
  ): ResultAsync<OwnerSkillRecord[], OwnerSkillError>;
}
export interface OwnerSkillsDeps {
  readonly store: OwnerSkillStore;
  /** Names of the bundled platform skills; owner skills may not take them. */
  readonly platformSkillNames: () => ResultAsync<ReadonlySet<string>, OwnerSkillError>;
}

const invalid = (message: string): OwnerSkillError => ({
  type: "owner_skill_error",
  code: "invalid",
  message,
});
const namePattern = new RegExp(OWNER_SKILL_NAME_PATTERN);
const parseYaml = Result.fromThrowable(parseFrontmatter, () => invalid("Invalid skill YAML"));

/** Accepts exactly what Pi's skill loader accepts, plus the Agent Skills name rule. */
export function parseOwnerSkill(
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

function toList(records: OwnerSkillRecord[]): Result<OwnerSkillList, OwnerSkillError> {
  const items: OwnerSkillList["items"] = [];
  for (const record of records) {
    const parsed = parseOwnerSkill({ content: record.content });
    if (parsed.isErr() || parsed.value.name !== record.name)
      return err({
        type: "owner_skill_error",
        code: "internal",
        message: "Owner skill storage is inconsistent",
      });
    items.push({ ...record, description: parsed.value.description });
  }
  return ok({ items });
}

function validWrite(
  deps: OwnerSkillsDeps,
  body: unknown,
): ResultAsync<OwnerSkillWrite, OwnerSkillError> {
  const parsed = parseOwnerSkill(body);
  if (parsed.isErr()) return errAsync(parsed.error);
  const { name, content } = parsed.value;
  return deps
    .platformSkillNames()
    .andThen((reserved) =>
      reserved.has(name)
        ? err(invalid(`"${name}" is a bundled platform skill`))
        : ok({ name, content }),
    );
}

export const listOwnerSkills = (task: SimulationTask, store: OwnerSkillStore, userId: string) =>
  store.list(task, userId).andThen(toList);

export const createOwnerSkill = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  userId: string,
  body: unknown,
) =>
  validWrite(deps, body)
    .andThen((skill) => deps.store.create(task, userId, skill))
    .andThen(toList);

export const replaceOwnerSkill = (
  task: SimulationTask,
  deps: OwnerSkillsDeps,
  userId: string,
  name: string,
  body: unknown,
) =>
  validWrite(deps, body)
    .andThen((skill) => deps.store.replace(task, userId, name, skill))
    .andThen(toList);

export const deleteOwnerSkill = (
  task: SimulationTask,
  store: OwnerSkillStore,
  userId: string,
  name: string,
) => store.delete(task, userId, name).andThen(toList);

/** What an agent context adopts at open: names and raw `SKILL.md` text. */
export const readOwnerSkillsSnapshot = (
  task: SimulationTask,
  store: OwnerSkillStore,
  userId: string,
): ResultAsync<OwnerSkillsSnapshot, OwnerSkillError> =>
  store
    .list(task, userId)
    .map((records) => ({ skills: records.map(({ name, content }) => ({ name, content })) }));

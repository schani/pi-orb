import { createHash, randomUUID } from "node:crypto";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  type OwnerSkillsSnapshot,
  ownerSkillCapturePath,
  validateOwnerSkillsSnapshot,
} from "@pi-orb/protocol";
import { errAsync, ok, okAsync, type ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  type ResourceError,
  type ResourceFile,
  type ResourceReader,
  type ResourceSnapshot,
  resourceError,
  SnapshotResourceReader,
} from "../../domain/resources.ts";
import { snapshotPromptResources } from "../git-resources/prompt.ts";

export interface ManagedResourceInstructions {
  personal: { content: string; revision: number };
  project: { content: string; revision: number };
  /** Owner skills (docs/owner-skills-secrets.md), adopted fresh at every context open. */
  skills: OwnerSkillsSnapshot["skills"];
}
/** Private native application document. Store implementation uses the fenced authority UOW. */
export interface PersistedPlatformContext {
  version: string;
  files: Array<{ path: string; base64: string; sha256: string }>;
}
export interface PlatformContextStore {
  get(): ResultAsync<PersistedPlatformContext | null, ResourceError>;
  put(snapshot: PersistedPlatformContext): ResultAsync<void, ResourceError>;
}
export interface PreparedResourceContext {
  captureId: string;
  ownerSkillRoot: string;
  commitSha: string | null;
  managed: ManagedResourceInstructions;
  instructions: Array<{ path: string; content: string }>;
  skills: Skill[];
  reader: ResourceReader;
  /** Content-free hash supports adoption diagnostics without exposing prompt text. */
  resourceHash: string;
}
const platformSchema = z.object({
  version: z.string().min(1).max(256),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        base64: z.string().max(24 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(5000),
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function decodePlatform(
  snapshot: PersistedPlatformContext,
): ResultAsync<ResourceFile[], ResourceError> {
  const parsed = platformSchema.safeParse(snapshot);
  if (!parsed.success)
    return errAsync(resourceError("invalid", "Invalid private platform snapshot"));
  const seen = new Set<string>();
  const files: ResourceFile[] = [];
  let total = 0;
  for (const file of parsed.data.files) {
    if (
      !file.path.startsWith("/opt/pi-orb/skills/") ||
      file.path.split("/").some((part) => part === ".." || part === ".") ||
      seen.has(file.path) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
    )
      return errAsync(resourceError("invalid", "Invalid private platform resource"));
    seen.add(file.path);
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.byteLength;
    if (total > 16 * 1024 * 1024 || digest(bytes) !== file.sha256)
      return errAsync(resourceError("invalid", "Invalid private platform resource"));
    files.push({ path: file.path, bytes, sha256: file.sha256 });
  }
  return okAsync(files);
}

/** Repository pin is immutable. Managed prompts refresh on every context, not every Git fetch. */
export function prepareResourceContext(options: {
  signal: AbortSignal;
  platformVersion: string;
  acquisition: { acquire(): ResultAsync<ResourceSnapshot | null, ResourceError> };
  managed: () => ResultAsync<ManagedResourceInstructions, ResourceError>;
  platformStore: PlatformContextStore;
  loadPlatform: () => ResultAsync<ResourceFile[], ResourceError>;
  check: () => ResultAsync<void, ResourceError>;
  /** Deterministic scheduling/failpoint seam before private context publication. */
  checkpoint?: () => ResultAsync<void, ResourceError>;
}): ResultAsync<PreparedResourceContext, ResourceError> {
  const captureId = randomUUID();
  const ownerSkillRoot = ownerSkillCapturePath(captureId);
  const check = () =>
    options.signal.aborted
      ? errAsync<void, ResourceError>(resourceError("cancelled", "Resource context cancelled"))
      : options.check();
  return check()
    .andThen(() => options.acquisition.acquire())
    .andThen((repository) =>
      options.managed().andThen((managed) =>
        check()
          .andThen(() => options.platformStore.get())
          .andThen((persisted) => {
            if (persisted?.version === options.platformVersion) return decodePlatform(persisted);
            return options.loadPlatform().andThen((files) => {
              const snapshot: PersistedPlatformContext = {
                version: options.platformVersion,
                files: files.map((file) => ({
                  path: file.path,
                  base64: Buffer.from(file.bytes).toString("base64"),
                  sha256: digest(file.bytes),
                })),
              };
              return decodePlatform(snapshot).andThen((validated) => {
                const prompt = snapshotPromptResources({
                  instructionPath: null,
                  skillRoot: "/opt/pi-orb/skills",
                  files: validated,
                });
                if (prompt.isErr()) return errAsync(prompt.error);
                return (options.checkpoint?.() ?? okAsync(undefined))
                  .andThen(check)
                  .andThen(() => options.platformStore.put(snapshot))
                  .map(() => validated);
              });
            });
          })
          .andThen((platformFiles) =>
            check().andThen(() => {
              const project = repository
                ? snapshotPromptResources(repository, { invalidSkills: "warn" })
                : ok({ instructions: [], skills: [] });
              if (project.isErr()) return errAsync(project.error);
              const platform = snapshotPromptResources({
                instructionPath: null,
                skillRoot: "/opt/pi-orb/skills",
                files: platformFiles,
              });
              if (platform.isErr()) return errAsync(platform.error);
              // Precedence: platform > owner > repository. Owner names are checked against
              // platform names at save, so a clash means a newer platform skill took the name.
              const validated = validateOwnerSkillsSnapshot({ skills: managed.skills });
              if (validated.isErr())
                return errAsync(resourceError("invalid", validated.error.message));
              const platformNames = new Set(platform.value.skills.map((skill) => skill.name));
              const ownerFiles = managed.skills
                .filter((skill) => !platformNames.has(skill.name))
                .flatMap((skill) =>
                  [
                    { path: "SKILL.md", bytes: Buffer.from(skill.content, "utf8") },
                    ...skill.files.map((file) => ({
                      path: file.path,
                      bytes: Buffer.from(file.base64, "base64"),
                    })),
                  ].map(({ path, bytes }) => ({
                    path: `${ownerSkillRoot}/${skill.name}/${path}`,
                    bytes,
                    sha256: digest(bytes),
                  })),
                );
              const owner = snapshotPromptResources(
                { instructionPath: null, skillRoot: ownerSkillRoot, files: ownerFiles },
                { invalidSkills: "warn" },
              );
              if (owner.isErr()) return errAsync(owner.error);
              const ownerNames = new Set(owner.value.skills.map((skill) => skill.name));
              const repositorySkills = project.value.skills.filter(
                (skill) => !ownerNames.has(skill.name),
              );
              const combined = [...(repository?.files ?? []), ...ownerFiles, ...platformFiles];
              const names = [...repositorySkills, ...platform.value.skills].map(
                (skill) => skill.name,
              );
              if (new Set(names).size !== names.length)
                return errAsync(
                  resourceError("invalid", "Duplicate repository and platform skill names"),
                );
              return okAsync({
                captureId,
                ownerSkillRoot,
                commitSha: repository?.commitSha ?? null,
                managed,
                instructions: project.value.instructions,
                skills: [...repositorySkills, ...owner.value.skills, ...platform.value.skills],
                reader: new SnapshotResourceReader({ files: combined }),
                resourceHash: digest(
                  Buffer.from(JSON.stringify(combined.map((file) => [file.path, file.sha256]))),
                ),
              });
            }),
          ),
      ),
    );
}

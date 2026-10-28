import {
  OWNER_SKILL_MAX_BYTES,
  OWNER_SKILLS_MAX_BYTES,
  OWNER_SKILLS_MAX_FILES,
  validateOwnerSkillsSnapshot,
  validOwnerSkillPath,
} from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  ownerSkillError as failure,
  type OwnerSkillBundle,
  type OwnerSkillError,
} from "../domain/owner-skills.ts";

const hash = Type.String({ pattern: "^[a-f0-9]{40}$" });
const commitSchema = Type.Object({
  sha: hash,
  commit: Type.Object({ tree: Type.Object({ sha: hash }) }),
});
const treeSchema = Type.Object({
  truncated: Type.Boolean(),
  tree: Type.Array(
    Type.Object({
      path: Type.String(),
      mode: Type.String(),
      type: Type.String(),
      sha: Type.Optional(hash),
      size: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  ),
});
const invalid = (message: string) => failure("invalid", message);

/** Anonymous GitHub REST acquisition; every blob uses the single resolved commit. */
export async function acquireGithubOwnerSkill(
  githubUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Result<OwnerSkillBundle, OwnerSkillError>> {
  const parsed = Result.fromThrowable(
    () => new URL(githubUrl),
    () => invalid("Expected a public GitHub folder URL"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const url = parsed.value;
  const decoded = Result.fromThrowable(
    () => githubUrl.split(/[?#]/, 1)[0]?.split("/").slice(3).map(decodeURIComponent) ?? [],
    () => invalid("Invalid GitHub URL encoding"),
  )();
  if (decoded.isErr()) return err(decoded.error);
  const parts = [
    ...decoded.value.slice(0, 3),
    ...decoded.value.slice(3).flatMap((part) => part.split("/")),
  ];
  if (
    url.protocol !== "https:" ||
    url.host !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length < 5 ||
    parts.length > 32 ||
    parts[2] !== "tree" ||
    parts.some((part) => !validOwnerSkillPath(part) || part.includes("/")) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? "") ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? "")
  )
    return err(invalid("Expected https://github.com/owner/repo/tree/ref/folder"));
  const [owner, repo] = parts;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const cancellation = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const request = async (target: string, candidate?: string) => {
    const response = await ResultAsync.fromThrowable(
      () =>
        fetcher(target, {
          redirect: "error",
          signal: cancellation,
          headers: { accept: "application/vnd.github+json" },
        }),
      () =>
        failure(
          "unavailable",
          cancellation.aborted ? "GitHub request cancelled or timed out" : "GitHub request failed",
        ),
    )();
    if (response.isErr()) return err(response.error);
    const missingCommit = response.value.status === 422 && candidate !== undefined;
    if (!response.value.ok && !missingCommit) {
      await ResultAsync.fromPromise(
        response.value.body?.cancel() ?? Promise.resolve(),
        () => undefined,
      );
      return err(
        failure(
          response.value.status === 404 ? "not_found" : "unavailable",
          `GitHub HTTP ${response.value.status}; public anonymous access required (rate limits may apply)`,
        ),
      );
    }
    const body = await ResultAsync.fromPromise(
      (async () => {
        const reader = response.value.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader)
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > OWNER_SKILLS_MAX_BYTES) {
              await reader.cancel();
              return err(invalid("GitHub response exceeds 8 MiB"));
            }
            chunks.push(item.value);
          }
        return ok(Buffer.concat(chunks));
      })(),
      () => failure("unavailable", "Cannot read GitHub response"),
    ).andThen((result) => result);
    if (body.isErr() || !missingCommit) return body;
    const absence = Result.fromThrowable(
      (): unknown => JSON.parse(body.value.toString("utf8")),
      () => undefined,
    )();
    return err(
      failure(
        absence.isOk() &&
          Check(
            Type.Object({ message: Type.Literal(`No commit found for SHA: ${candidate}`) }),
            absence.value,
          )
          ? "not_found"
          : "unavailable",
        "GitHub HTTP 422; public anonymous access required (rate limits may apply)",
      ),
    );
  };
  const json = async (target: string, candidate?: string) =>
    (await request(target, candidate)).andThen((bytes) =>
      Result.fromThrowable(
        (): unknown => JSON.parse(bytes.toString("utf8")),
        () => invalid("Invalid GitHub JSON"),
      )(),
    );
  let pinned: { sha: string; tree: string; folder: string[] } | undefined;
  for (let split = parts.length - 1; split > 3; split--) {
    const candidate = parts.slice(3, split).join("/");
    const resolved = await json(`${api}/commits/${encodeURIComponent(candidate)}`, candidate);
    if (resolved.isErr()) {
      if (resolved.error.code === "not_found") continue;
      return err(resolved.error);
    }
    if (!Check(commitSchema, resolved.value)) return err(invalid("Invalid GitHub commit"));
    pinned = {
      sha: resolved.value.sha,
      tree: resolved.value.commit.tree.sha,
      folder: parts.slice(split),
    };
    break;
  }
  if (!pinned) return err(failure("not_found", "GitHub ref or folder doesn't exist"));
  let tree = pinned.tree;
  for (const component of pinned.folder) {
    const result = await json(`${api}/git/trees/${tree}`);
    if (result.isErr()) return err(result.error);
    if (!Check(treeSchema, result.value) || result.value.truncated)
      return err(invalid("Incomplete GitHub tree"));
    const entry = result.value.tree.find((entry) => entry.path === component);
    if (entry?.type !== "tree" || entry.mode !== "040000" || !entry.sha)
      return err(invalid("GitHub skill folder doesn't exist or is not a directory"));
    tree = entry.sha;
  }
  const result = await json(`${api}/git/trees/${tree}?recursive=1`);
  if (result.isErr()) return err(result.error);
  if (!Check(treeSchema, result.value) || result.value.truncated)
    return err(invalid("Incomplete GitHub skill tree"));
  const entries = result.value.tree.filter((entry) => entry.type !== "tree");
  let encodedSize = 0;
  const paths = new Set<string>();
  for (const entry of result.value.tree) {
    if (
      !validOwnerSkillPath(entry.path) ||
      paths.has(entry.path) ||
      (entry.type === "tree"
        ? entry.mode !== "040000"
        : entry.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode) ||
          entry.size === undefined)
    )
      return err(invalid("GitHub skill contains an unsafe path, link or unsupported file"));
    paths.add(entry.path);
    if (entry.type !== "tree") encodedSize += 4 * Math.ceil((entry.size ?? 0) / 3);
  }
  if (!entries.some((entry) => entry.path === "SKILL.md"))
    return err(invalid("GitHub folder requires root SKILL.md"));
  if (
    entries.length > OWNER_SKILLS_MAX_FILES ||
    encodedSize > OWNER_SKILLS_MAX_BYTES ||
    entries.some((entry) => entry.path === "SKILL.md" && (entry.size ?? 0) > OWNER_SKILL_MAX_BYTES)
  )
    return err(invalid("GitHub skill exceeds owner snapshot bounds (8 MiB / 1000 files)"));
  const bundle: OwnerSkillBundle = {
    content: "",
    files: [],
    source: {
      url: `https://github.com/${owner}/${repo}/tree/${pinned.sha}/${pinned.folder.map(encodeURIComponent).join("/")}`,
      commitSha: pinned.sha,
    },
  };
  for (const entry of entries) {
    const path = [...pinned.folder, ...entry.path.split("/")].map(encodeURIComponent).join("/");
    const bytes = await request(
      `https://raw.githubusercontent.com/${owner}/${repo}/${pinned.sha}/${path}`,
    );
    if (bytes.isErr()) return err(bytes.error);
    if (bytes.value.byteLength !== entry.size)
      return err(invalid("GitHub file size disagrees with pinned tree"));
    if (entry.path === "SKILL.md") {
      const text = Result.fromThrowable(
        () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
        () => invalid("SKILL.md must be UTF-8"),
      )();
      if (text.isErr()) return err(text.error);
      bundle.content = text.value;
    } else
      bundle.files.push({
        path: entry.path,
        base64: bytes.value.toString("base64"),
        executable: entry.mode === "100755",
      });
  }
  const checked = validateOwnerSkillsSnapshot({ skills: [{ name: "import", ...bundle }] });
  return checked.isErr() ? err(invalid(checked.error.message)) : ok(bundle);
}

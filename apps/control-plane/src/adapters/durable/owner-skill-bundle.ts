import { createHash } from "node:crypto";
import type { OwnerSkillsSnapshot } from "@pi-orb/protocol";
import { OwnerSkillsSnapshotSchema } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { Check } from "typebox/value";
import { type ResourceError, type ResourceFile, resourceError } from "../../domain/resources.ts";

export interface OwnerSkillBundle {
  hash: string;
  root: string;
  files: Array<ResourceFile & { executable: boolean }>;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Source URLs are provenance, not executable content or prompt text. */
export function ownerSkillBundle(
  skills: OwnerSkillsSnapshot["skills"],
  parent = "../.pi-orb/owner-skills",
): Result<OwnerSkillBundle, ResourceError> {
  const invalid = () =>
    err<OwnerSkillBundle, ResourceError>(
      resourceError("invalid", "Invalid captured owner skill bundle."),
    );
  if (!Check(OwnerSkillsSnapshotSchema, { skills })) return invalid();
  const names = new Set<string>();
  const files: OwnerSkillBundle["files"] = [];
  let total = 0;
  for (const skill of skills) {
    if (names.has(skill.name)) return invalid();
    names.add(skill.name);
    const entries = [
      {
        path: "SKILL.md",
        base64: Buffer.from(skill.content).toString("base64"),
        executable: false,
      },
      ...skill.files,
    ];
    const paths = new Set<string>();
    let skillBytes = 0;
    for (const entry of entries) {
      if (
        entry.path.includes("\\") ||
        entry.path.includes("\0") ||
        entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
        paths.has(entry.path) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64) ||
        Buffer.from(entry.base64, "base64").toString("base64") !== entry.base64
      )
        return invalid();
      paths.add(entry.path);
      const bytes = Buffer.from(entry.base64, "base64");
      skillBytes += bytes.byteLength;
      files.push({
        path: `${skill.name}/${entry.path}`,
        bytes,
        sha256: digest(bytes),
        executable: entry.executable,
      });
    }
    if (skillBytes > 8 * 1024 * 1024) return invalid();
    total += skillBytes;
    for (const path of paths) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join("/"))) return invalid();
      }
    }
  }
  if (total > 16 * 1024 * 1024) return invalid();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = digest(
    Buffer.from(JSON.stringify(files.map((f) => [f.path, f.sha256, f.executable]))),
  );
  const root = `${parent}/${hash}`;
  return ok({ hash, root, files: files.map((f) => ({ ...f, path: `${root}/${f.path}` })) });
}

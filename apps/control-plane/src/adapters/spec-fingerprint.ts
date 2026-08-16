import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, array order preserved,
 * primitives untouched. `JSON.stringify` encodes keys in insertion order, so
 * two revisions that build the same effective specification through different
 * code paths would serialize differently and disagree about the fingerprint.
 * The fingerprint must be a pure function of the effective specification —
 * anything else replaces the whole fleet's compute on the next Start for no
 * reason (docs/compute-replacement.md).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sorted: Record<string, unknown> = {};
  for (const [key, entry] of entries) sorted[key] = canonicalize(entry);
  return sorted;
}

/**
 * The one host-specification fingerprint calculation, shared by every host
 * provider (`desiredSpecFingerprint`, docs/compute-replacement.md). Callers
 * pass the non-secret launch facts whose change requires replacing compute.
 */
export function specFingerprintOf(parts: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(parts)))
    .digest("hex");
}

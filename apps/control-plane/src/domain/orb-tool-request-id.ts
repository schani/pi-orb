import { createHash } from "node:crypto";

/** Stable UUID scoped to the calling orb and durable tool task, never supplied by model arguments. */
export function orbToolRequestId(orbId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([orbId, requestId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

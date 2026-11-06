const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const canonicalOrb = new RegExp(`^${uuid}$`, "u");
const target = new RegExp(`^/files/(repo/)?(${uuid})(/.*)$`, "u");

export function liveFileRoute(
  url: string,
): { orbId: string; path: string; base?: "repo" } | undefined {
  const match = target.exec(url);
  return match
    ? {
        orbId: match[2] ?? "",
        path: match[3] ?? "",
        ...(match[1] ? { base: "repo" as const } : {}),
      }
    : undefined;
}

export function isFilesReadPath(url: string): boolean {
  return /^\/s\/[^/]+\//u.test(url) || liveFileRoute(url) !== undefined;
}

export function orbFilesBaseUrl(
  filesOrigin: string | undefined,
  provider: string,
  orbId: string,
): string | null {
  return filesOrigin &&
    (provider === "docker" || provider === "gce" || provider === "process") &&
    canonicalOrb.test(orbId)
    ? `${filesOrigin}/files/${orbId}`
    : null;
}

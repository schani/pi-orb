import { err, ok, Result } from "neverthrow";

export interface RepositoryUrlError {
  type: "repository_url_error";
  code:
    | "invalid_url"
    | "scheme_not_allowed"
    | "host_not_allowed"
    | "userinfo_not_allowed"
    | "port_not_allowed"
    | "ip_literal_not_allowed"
    | "invalid_repository_path";
  message: string;
}

export interface ValidatedRepositoryUrl {
  /** Normalized URL string (lowercased host, no trailing slash). */
  url: string;
  host: string;
  pathSegments: string[];
}

export interface RepositoryUrlOptions {
  allowedHosts?: readonly string[];
}

/**
 * Hosts accepted by default. Extending this list is configuration, not a
 * design change (DESIGN.md §11.1).
 */
export const DEFAULT_ALLOWED_REPOSITORY_HOSTS: readonly string[] = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
];

/** Hosts whose repository paths may contain nested groups. */
const SUBGROUP_HOSTS: ReadonlySet<string> = new Set(["gitlab.com"]);

const MAX_PATH_SEGMENTS = 10;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const parseUrl = Result.fromThrowable(
  (raw: string) => new URL(raw),
  (): RepositoryUrlError => ({
    type: "repository_url_error",
    code: "invalid_url",
    message: "not a parseable absolute URL",
  }),
);

function fail(
  code: RepositoryUrlError["code"],
  message: string,
): Result<ValidatedRepositoryUrl, RepositoryUrlError> {
  return err({ type: "repository_url_error", code, message });
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[")) return true; // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment;
}

/**
 * Strict allowlist validation per DESIGN.md §11.1. Runs at project creation
 * and again in the runtime immediately before cloning.
 */
export function validateRepositoryUrl(
  raw: string,
  options?: RepositoryUrlOptions,
): Result<ValidatedRepositoryUrl, RepositoryUrlError> {
  const parsed = parseUrl(raw);
  if (parsed.isErr()) return err(parsed.error);
  const url = parsed.value;

  if (url.protocol !== "https:") {
    return fail("scheme_not_allowed", `scheme must be https, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    return fail("userinfo_not_allowed", "credential-bearing URLs are not allowed");
  }
  if (url.port !== "") {
    return fail("port_not_allowed", "explicit ports are not allowed");
  }
  if (isIpLiteral(url.hostname)) {
    return fail("ip_literal_not_allowed", "IP-literal hosts are not allowed");
  }

  const allowedHosts = options?.allowedHosts ?? DEFAULT_ALLOWED_REPOSITORY_HOSTS;
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    return fail("host_not_allowed", `host ${host} is not on the repository allowlist`);
  }

  if (url.search !== "" || url.hash !== "") {
    return fail("invalid_repository_path", "query strings and fragments are not allowed");
  }
  if (url.pathname.endsWith("/")) {
    return fail("invalid_repository_path", "trailing slashes are not allowed");
  }

  const segments = url.pathname.split("/").slice(1);
  const maxSegments = SUBGROUP_HOSTS.has(host) ? MAX_PATH_SEGMENTS : 2;
  if (segments.length < 2 || segments.length > maxSegments) {
    return fail(
      "invalid_repository_path",
      `path must have between 2 and ${maxSegments} segments for ${host}`,
    );
  }
  for (const [index, rawSegment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const segment = isLast ? stripGitSuffix(rawSegment) : rawSegment;
    if (!SEGMENT_PATTERN.test(segment) || segment.includes("..")) {
      return fail(
        "invalid_repository_path",
        `path segment ${JSON.stringify(rawSegment)} is invalid`,
      );
    }
  }

  const normalized = `https://${host}${url.pathname}`;
  return ok({ url: normalized, host, pathSegments: segments });
}

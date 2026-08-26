import { join } from "node:path";
import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  RUNTIME_TOKEN_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
} from "@pi-orb/protocol";

/** Set in every orb process so a script can branch on the platform (`PI_ORB=1`). */
export const ORB_MARKER_ENV = "PI_ORB";
export const HOOK_NAME_ENV = "PI_ORB_HOOK";
/** Handed to both hooks so a script never has to hardcode the env file's path. */
export const HOOK_ENV_FILE_ENV = "PI_ORB_HOOK_ENV_FILE";

/**
 * Where a hook writes the variables it wants the agent to have
 * (`docs/orb-setup-hook.md`, decided 2026-08-26). It lives in the persistent
 * home, so what a hook puts there survives stop/start and compute replacement.
 * Nothing a hook *exports* reaches the agent — neither Pi's `bash -c` tool
 * shells nor the terminal's `bash --noprofile --norc` read a profile — so this
 * file is the only channel.
 */
export const hookEnvPath = (home: string): string => join(home, ".pi-orb", "env");

/**
 * Names the runtime owns. An entry naming one of these is ignored rather than
 * applied: a hook that could rewrite `PATH`, `HOME`, or the bearer's own
 * variables would be able to break the contract every later boot depends on,
 * and the failure would look like a platform bug rather than a hook.
 */
export const HOOK_ENV_DENIED: readonly string[] = [
  RUNTIME_TOKEN_ENV,
  CONTROL_PLANE_URL_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
  PREVIEW_HOST_ENV,
  ORB_MARKER_ENV,
  "PI_ORB_ID",
  "PI_ORB_HOST_INCARNATION",
  "PI_ORB_WORK_DIR",
  "HOME",
  "PATH",
];

/** What the runtime did with the env file, for the status file and the prompt. */
export interface HookEnvReport {
  readonly path: string;
  /** Names merged into the runtime's environment, in file order. */
  readonly applied: readonly string[];
  /** Names the runtime owns, refused rather than applied. */
  readonly ignored: readonly string[];
  /** One reason per unusable line — the line number, never its content. */
  readonly malformed: readonly string[];
}

export interface HookEnvFile {
  /** Parsed entries in file order; a repeated name keeps its last value. */
  readonly entries: ReadonlyMap<string, string>;
  readonly ignored: readonly string[];
  readonly malformed: readonly string[];
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strips one matching pair of surrounding quotes and nothing else. There is no
 * escape processing and no expansion by design: a value is whatever the hook
 * wrote, so a script never has to guess how the runtime will re-read it.
 */
const unquote = (value: string): string => {
  const quote = value.at(0);
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
};

/**
 * The whole format: one `KEY=VALUE` per line, `#` comments and blank lines
 * ignored, the value taken literally apart from an optional single pair of
 * matching quotes. Kept this small on purpose — a hook writes the file with
 * `printf`, and a shell-compatible parser would invite `$(…)` in a file the
 * runtime reads into its own process.
 *
 * A malformed line is reported by number only: a value may be a credential,
 * and the report reaches a status file and the agent's context.
 */
export function parseHookEnvFile(text: string): HookEnvFile {
  const entries = new Map<string, string>();
  const ignored: string[] = [];
  const malformed: string[] = [];
  const denied = new Set(HOOK_ENV_DENIED);
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      malformed.push(`line ${index + 1}: no "=" separator`);
      return;
    }
    const name = trimmed.slice(0, separator).trim();
    if (!NAME_PATTERN.test(name)) {
      malformed.push(`line ${index + 1}: not a variable name`);
      return;
    }
    if (denied.has(name)) {
      ignored.push(name);
      return;
    }
    entries.set(name, unquote(trimmed.slice(separator + 1).trim()));
  });
  return { entries, ignored, malformed };
}

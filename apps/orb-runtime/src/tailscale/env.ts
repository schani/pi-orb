import { PREVIEW_HOST_ENV, TAILSCALE_AUTH_KEY_ENV, TAILSCALE_HOSTNAME_ENV } from "@pi-orb/protocol";

export interface TailscaleEnv {
  /** Pre-authorized per-orb tailnet auth key (a secret). */
  readonly authKey: string;
  /** Tailnet machine hostname, `pi-orb-<orbId>`. */
  readonly hostname: string;
  /** MagicDNS FQDN the user reaches this orb by. */
  readonly previewHost: string;
}

/**
 * Tier-1 port exposure (docs/ports.md) is optional: the provider delivers all
 * three variables together or none of them. A partial set is treated like an
 * absent one — announcing a preview host the daemon cannot actually serve
 * would be worse than not exposing ports at all.
 */
export function readTailscaleEnv(env: Record<string, string | undefined>): TailscaleEnv | null {
  const authKey = env[TAILSCALE_AUTH_KEY_ENV];
  const hostname = env[TAILSCALE_HOSTNAME_ENV];
  const previewHost = env[PREVIEW_HOST_ENV];
  if (
    authKey === undefined ||
    authKey === "" ||
    hostname === undefined ||
    hostname === "" ||
    previewHost === undefined ||
    previewHost === ""
  ) {
    return null;
  }
  return { authKey, hostname, previewHost };
}

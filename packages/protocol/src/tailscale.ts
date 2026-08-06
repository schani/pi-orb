/**
 * Tailscale tier-1 port exposure (docs/ports.md). Orb hosts join the
 * user's tailnet so every TCP port a server listens on inside the orb is
 * directly reachable from the user's devices as
 * `http://pi-orb-<orbId>.<tailnet>.ts.net:<port>`. The control plane
 * derives the tailnet identity from the orb id; providers deliver it to
 * the host through these environment variables at creation. The runtime
 * starts tailscaled (userspace networking) when they are present and
 * silently skips the feature when they are absent.
 */

/**
 * Per-orb pre-authorized tailnet auth key. A secret, minted by the host
 * provider at actual host creation (read-back on reuse, like the runtime
 * token) — never re-minted for an existing host.
 */
export const TAILSCALE_AUTH_KEY_ENV = "PI_ORB_TAILSCALE_AUTH_KEY";

/** Tailnet machine hostname, `pi-orb-<orbId>`. */
export const TAILSCALE_HOSTNAME_ENV = "PI_ORB_TAILSCALE_HOSTNAME";

/**
 * MagicDNS FQDN the user reaches the orb by,
 * `pi-orb-<orbId>.<tailnet dns name>`. Presence of this variable is what
 * tells the runtime the feature is on; it is surfaced to the agent in the
 * session's system prompt.
 */
export const PREVIEW_HOST_ENV = "PI_ORB_PREVIEW_HOST";

/** ACL tag every orb node carries; the Tailscale OAuth client must own it. */
export const TAILSCALE_ORB_TAG = "tag:pi-orb";

export function tailscaleHostname(orbId: string): string {
  return `pi-orb-${orbId}`;
}

export function previewHost(orbId: string, tailnetDnsName: string): string {
  return `${tailscaleHostname(orbId)}.${tailnetDnsName}`;
}

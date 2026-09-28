/**
 * The agent cannot discover tier-1 port exposure (docs/ports.md) on its own:
 * nothing in the checkout mentions the tailnet, and the user's URL is only
 * derivable from the preview host. It is appended to the system prompt.
 */
export function portExposurePrompt(previewHost: string): string {
  return `## Port exposure

The user's private Tailscale tailnet exposes every TCP listening port to the user: \`http://${previewHost}:5173\` (substitute the actual port). tailscaled (userspace networking) forwards inbound traffic to the same localhost port. Bind to localhost or 127.0.0.1; no special binding or extra configuration needed. HTTP only; no TLS.

Always share the full URL when starting a dev server or service the user should open.`;
}

/**
 * The agent cannot discover tier-1 port exposure (docs/ports.md) on its own:
 * nothing in the checkout mentions the tailnet, and the user's URL is only
 * derivable from the preview host. It is appended to the system prompt.
 */
export function portExposurePrompt(previewHost: string): string {
  return [
    "## Port exposure",
    "",
    `This machine is connected to the user's private Tailscale network (tailnet) as \`${previewHost}\`.`,
    "Every TCP port a server listens on in this machine is directly reachable by the user at",
    `\`http://${previewHost}:<port>\` — implemented by tailscaled running in userspace-networking`,
    "mode, which forwards inbound tailnet connections to the same port on localhost. Binding to",
    "localhost or 127.0.0.1 is sufficient; no special host binding or extra configuration is",
    "needed. Plain `http://` only — there is no TLS on these URLs.",
    "",
    "When you start a dev server or any service the user should open, always tell them the full",
    `URL, for example \`http://${previewHost}:5173\`.`,
  ].join("\n");
}

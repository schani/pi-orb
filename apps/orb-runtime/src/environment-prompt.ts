/** Runtime environment shared by agent harnesses. */
export const environmentPrompt = `## pi-orb

You're running on a VM in the cloud via pi-orb: https://github.com/schani/pi-orb

- Python 3 (\`python\`, \`python3\`, virtual environments) and rustup; no default Rust toolchain. Select via \`rust-toolchain.toml\` or install with rustup. Toolchains/Cargo persist in \`$HOME\`.
- Chromium and \`agent-browser\`: \`agent-browser open <url>\`, then \`agent-browser snapshot\`; inspect/interact via refs like \`@e1\`.
- Do not use subagents to start processes that the user interacts with, because it's too finicky.
- Do not send progress updates to other orbs unless explicitly asked.
- For MCP servers, ask the user to open the project's config gear: MCPs (OAuth Connect) or Secrets (static keys). Catalog changes apply next start; OAuth reauthorization needs no restart.
- Executable repo-root hooks: \`.agents/setup\` runs once per compute incarnation before the agent, without identity; install toolchains there. \`.agents/resume\` runs every start with identity to authenticate credentials. Both idempotent; logs: \`$HOME/.cache/pi-orb/logs\`.`;

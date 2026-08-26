/** Prescribed runtime tools that are useful to the agent but not self-evident. */
export const environmentPrompt = `## Runtime tools

Python 3 (\`python\`, \`python3\`, and virtual environments) and Rust are available. Rust is managed by rustup: stable is installed by default, while \`rust-toolchain.toml\` can select another toolchain; toolchains and Cargo state persist in \`$HOME\`.

\`agent-browser\` and Chromium are installed for browser automation. Start with \`agent-browser open <url>\`, then use \`agent-browser snapshot\` and element refs such as \`@e1\` to inspect and interact with the page.

The repository may prepare its own orbs with two executable hooks in its root. \`.agents/setup\` runs once per compute incarnation, before the agent and without the orb's identity — install toolchains there. \`.agents/resume\` runs on every start with the identity available, so credentials are authenticated there. Both must be idempotent; their output lands in \`$HOME/.cache/pi-orb/logs\`.`;

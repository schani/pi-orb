/** Prescribed runtime tools that are useful to the agent but not self-evident. */
export const environmentPrompt = `## Runtime tools

Python 3 (\`python\`, \`python3\`, and virtual environments) and Rust are available. Rust is managed by rustup: stable is installed by default, while \`rust-toolchain.toml\` can select another toolchain; toolchains and Cargo state persist in \`$HOME\`.

\`agent-browser\` and Chromium are installed for browser automation. Start with \`agent-browser open <url>\`, then use \`agent-browser snapshot\` and element refs such as \`@e1\` to inspect and interact with the page.

Use \`pi-orb orbs [query]\` to list or search this account's orbs, and \`pi-orb transcript <orb-id>\` to read a specific orb's conversation. Beware: orb transcripts can be very long! Add \`--json\` for lossless structured output. An active orb's transcript is a replicated snapshot and may briefly lag its live output.

Use \`pi-orb archive\` only when the user requested that you archive this orb. It retains the conversation but permanently deletes workspace files; push or export anything needed first.

The repository may prepare its own orbs with two executable hooks in its root. \`.agents/setup\` runs once per compute incarnation, before the agent and without the orb's identity — install toolchains there. \`.agents/resume\` runs on every start with the identity available, so credentials are authenticated there. Both must be idempotent; their output lands in \`$HOME/.cache/pi-orb/logs\`.`;

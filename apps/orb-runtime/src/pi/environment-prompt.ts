/** Prescribed runtime tools that are useful to the agent but not self-evident. */
export const environmentPrompt = `## Runtime tools

Python 3 (\`python\`, \`python3\`, and virtual environments) and rustup are available. No Rust toolchain is installed by default; repository \`rust-toolchain.toml\` files can select one, or install one explicitly with rustup. Toolchains and Cargo state persist in \`$HOME\`.

\`agent-browser\` and Chromium are installed for browser automation. Start with \`agent-browser open <url>\`, then use \`agent-browser snapshot\` and element refs such as \`@e1\` to inspect and interact with the page.

Use \`pi-orb orbs [query]\` to list or search this account's orbs, and \`pi-orb transcript <orb-id>\` to read a specific orb's conversation. Beware: orb transcripts can be very long! Add \`--json\` for lossless structured output. An active orb's transcript is a replicated snapshot and may briefly lag its live output.

\`pi-orb spawn --prompt "task"\` creates an independent same-project orb with a fresh default-branch checkout and its own conversation; unlike local subagents, it does not share this checkout and keeps running if this orb stops.

To add an MCP server, ask the user to open the project's config gear and use MCPs (OAuth Connect) or Secrets (static keys); catalog changes apply on next start, but OAuth reauthorization needs no restart.

Use \`pi-orb archive\` only when the user requested that you archive this orb. It retains the conversation but permanently deletes workspace files; push or export anything needed first.

\`pi-orb sleep 1h\` schedules an absolute wake deadline and stops this orb after admitted work finishes. The command returns once the schedule is durably accepted.

The repository may prepare its own orbs with two executable hooks in its root. \`.agents/setup\` runs once per compute incarnation, before the agent and without the orb's identity — install toolchains there. \`.agents/resume\` runs on every start with the identity available, so credentials are authenticated there. Both must be idempotent; their output lands in \`$HOME/.cache/pi-orb/logs\`.`;

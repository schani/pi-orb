/** Prescribed runtime tools that are useful to the agent but not self-evident. */
export const environmentPrompt = `## Runtime tools

Python 3 (\`python\`, \`python3\`, and virtual environments) and Rust are available. Rust is managed by rustup: stable is installed by default, while \`rust-toolchain.toml\` can select another toolchain; toolchains and Cargo state persist in \`$HOME\`.`;

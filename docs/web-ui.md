# Web UI

The UI must support two modes without visibly changing data sources:

- **Stopped/unavailable orb:** show the complete replicated history from the control plane database.
- **Active orb:** first show database history, then attach live updates after the database cursor while the host may still be starting.

The first UI needs to display at least:

- user text as plain text and assistant text as Markdown, for both committed history and live streaming;
- reasoning/thinking when available and permitted;
- tool-call and tool-result status, with inputs and outputs available only through collapsed disclosures by default;
- compaction summaries;
- runtime state such as starting, working, idle, stopped, or failed.

Remaining UI questions include rendering unknown content blocks, large/truncated tool output, and image storage. Transient token deltas are ephemeral presentation events and are reconstructed after reconnect through ordinary live events; they are not stored in PostgreSQL.

## Visual design (decided)

The UI uses the "Reading Room" variant of the Manuscript × Gutter design, chosen from a design exploration (five initial directions, then a Manuscript × Gutter hybrid, then five typography variations). Decisions:

- **Paper/ink palette, light mode only.** Warm paper ground (`#f8f3e9`), ink text (`#221c12`), terracotta accent (`#a03e1c`). No dark mode — explicit product decision.
- **Reading typography.** Agent prose is set in a Charter/Iowan Old Style serif stack at 17.5px/1.7; user messages are larger italic serif "margin notes" on terracotta blocks; headings and buttons use small-caps serif; structural meta (labels, chips, tool output, orb ids) is quiet monospace. All fonts are system stacks — no webfonts.
- **Turn gutter.** Every chat turn carries a gutter column: a marked square (`Y` filled terracotta for the user, `O` outlined ink for the agent) with a fading vertical rail. Adjacent agent-side records (assistant, tool results, displayed events) group into a single agent turn; compaction renders as a full-width dashed divider crossing the gutter.
- **Fluid width.** No max-width constraint — the manuscript fills the window at any size.
- **Composer.** Sticky at the viewport bottom, full-bleed; serif input, round ink send button (`↑`, ⌘⏎ shortcut), small-caps terracotta abort in the same row; chat scrolls in the normal document flow with bottom-pinned auto-follow (scroll pinning in `apps/web/src/lib/scroll-pin.ts`).
- **Compact sticky orb header (decided and implemented 2026-08-05).** On the orb chat route, the standalone orb-status card is removed. The chosen design is the single-strip “one line” exploration: the global `pi-orb` header contains the orb id with state version and checkout as a quiet second line, followed by the runtime-state badge, connection/activity, and lifecycle controls. The 54px header is sticky at the top of the viewport so state and controls remain visible while the conversation scrolls. On narrow screens, checkout and connection/activity hide first while identity, runtime state, and lifecycle controls remain visible. Lifecycle and authentication diagnostics stay in the conversation area immediately below the header. The temporary static HTML alternatives used to choose this design were removed after selection.
- **Chat URL linkification (decided and implemented 2026-08-05).** Web URL literals in chat prose are clickable in committed and streaming content. Assistant Markdown uses the GFM autolink-literal extension, so URL recognition composes with Markdown parsing and never linkifies code spans/blocks or existing link syntax a second time. User messages, displayed custom messages, reasoning, and compaction summaries remain literal non-Markdown text and pass through a dedicated URL tokenizer instead of an ad-hoc regular expression. Only HTTP(S) and `www.` web URLs are linked; email and other schemes remain text. Generated external links open in a new tab with `noopener noreferrer`. Tool inputs and outputs remain verbatim code-like text and are deliberately not linkified.

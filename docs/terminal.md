# Interactive orb terminal

A running orb page has an interactive shell. The PTY lives in the orb runtime and is reached through a second control-plane WebSocket:

```text
wterm in OrbPage
  |  WS /api/v1/orbs/:orbId/terminal   (browser-facing)
  v
control-plane byte proxy
  |  WS /v1/terminal on the observed runtimeAddress
  v
orb runtime -> PTY -> /bin/bash in <work-dir>/repo
```

Every provider (Docker, GCE, native VM, process) runs the same Node runtime and exposes its HTTP address to the control plane, so terminal support needs no provider-specific code. The PTY runs where the checkout, persistent `$HOME`, tools and broker environment already are. No `exec`, SSH, public port, database row or control-plane shell is involved. Rejected: `exec` on `OrbHostProvider` (duplicates per-provider streaming/resize and bypasses the runtime boundary).

The provider interface, database schema, history model, lifecycle state machine and agent live protocol are untouched by the terminal.

## Session semantics

The terminal is deliberately ephemeral. Filesystem work is the durable value; screen state is not.

- One terminal WebSocket owns one fresh `/bin/bash --noprofile --norc` PTY in `<work-dir>/repo`, with `TERM=xterm-256color`, the runtime's `HOME` and environment, and prompt `PS1="# "`. Skipping profiles keeps provider-specific prompts and paths out.
- Closing the browser socket, stopping the orb, runtime restart, transport failure or shell exit ends the session. Entering `stopping` closes agent and terminal proxies at once, with reconciler backstop after control-plane restart. No tmux, detach, persistence, replay or restoration.
- A transport failure ends the session visibly; the user opens a new terminal. Never silently reconnect to a different shell or replay keystrokes. Upstream status-less or abnormal closes normalize to 1013, and a forwarding exception terminates the browser transport (shared close-code contract: `docs/runtime-protocol.md`).
- Each browser tab gets its own PTY, up to four per runtime. Tabs never share input or screen.
- Hiding the shade keeps the component and socket mounted. Leaving the orb page ends the session.
- The runtime refuses a terminal until it is ready and the checkout exists. Stopped, unavailable, archiving, archived and deleting orbs have no terminal.
- The agent connection reports tab visibility for idle-stop protection; terminal input also refreshes the advisory `last_busy_at`.
- PTY input/output is not agent history and is not replicated. It runs concurrently with the agent in the same checkout, as part of the trusted-orb execution model.

## Wire protocol

Subprotocol `pi-orb.terminal.v1`, separate from the agent live protocol (which carries closed JSON text frames with history-sync and request-identity rules; terminal traffic is high-volume binary with none of that). Constants: `packages/protocol/src/terminal.ts`.

The first browser frame is a JSON text control:

```ts
{ v: 1, type: "terminal.open", cols: number, rows: number }
```

After acceptance:
- browser binary frames are UTF-8 input; browser text frames are closed JSON controls (`terminal.resize`);
- runtime binary frames are raw PTY output; runtime text frames are closed JSON `terminal.ready`, `terminal.exit` and typed `terminal.error`.

Frame kind plus direction separates bytes from controls with no escaping. Rejected: wterm's example `ESC[RESIZE:…]` sentinel, which shares a namespace with real input.

**Limits.** 20–500 columns, 5–200 rows, 64 KiB per input frame, four concurrent sessions per runtime. Both proxy hops close with a typed error when buffered output exceeds 1 MiB (slow consumer); the proxy also bounds queued input. Input and resize are serial per PTY.

**Proxy.** The control-plane route follows the agent route's lifecycle lookup and `OrbHostProvider.observe()`, then forwards frames and closes without reading PTY content. It allows binary frames and sends no `client.hello`. Authentication sits on the browser upgrade and the existing control-plane↔runtime trust boundary, as for the agent socket.

**Never log output.** Terminal bytes must never reach application logs, lifecycle events, PostgreSQL or error payloads; they routinely contain source, credentials and escape sequences.

## Runtime PTY

A real terminal needs a Unix PTY (`forkpty`/`openpty`, `ioctl(TIOCSWINSZ)`); `child_process` pipes give no controlling terminal, modes, job control or resize.

The runtime uses official `node-pty` 1.1.0 behind a narrow `Result`-returning adapter. The module loads through that fallible adapter, not a top-level import, so a missing or broken native binding shows a terminal error instead of crash-looping the runtime before health answers. Every third-party call and callback is caught at the adapter boundary.

`TerminalManager` (`apps/orb-runtime/src/terminal/manager.ts`) enforces the session limit, reserving capacity synchronously across async addon loading, tracks PTYs, exposes close reasons and closes every PTY on runtime shutdown. The process provider has no container or cgroup boundary, so stopping its runtime must leave no shell or foreground child behind (Linux only).

**Packaging.**
- `node-pty` is one of the root package's allowed lifecycle-script dependencies (`docs/stack.md`).
- Official 1.1.0 ships no Linux prebuild. Images run `npm ci --ignore-scripts`, then, in a separate offline `RUN --network=none` step, delete `node_modules/node-pty/prebuilds` (forcing the `node-gyp` path and dropping ~58 MiB of Darwin/Windows binaries), run `npm_config_nodedir=/usr/local npm rebuild node-pty`, then smoke-spawn a PTY at build time. Deleting `prebuilds` is preferred to `npm_config_build_from_source`, which npm 11 warns will stop working.
- The addon is built inside the image for its target architecture (production forces `linux/amd64` in `infra/build-push.sh`). Never copy a host addon into an image.
- macOS development uses the package's Darwin binaries and `spawn-helper` (`scripts/fix-node-pty-prebuild-permissions.mjs` repairs the extracted helper's mode). `node_modules` is platform-specific; reinstall rather than copy across OS or architecture.
- Linux development and CI need `python3` and `build-essential` (make, gcc, g++, libc headers including `libutil`) for `node-gyp`. Workflows install these explicitly.
- Making the dependency optional is rejected: terminal support would silently depend on the environment.
- A native crash can take down the runtime and cannot become a `Result`. Pin and review the package and exercise the compiled artifact in the image boot gate.

**Rejected alternatives.**
- A Python standard-library PTY helper: works, but adds a Python prerequisite and a first-party framing/signal/cleanup protocol.
- A prebuilt `node-pty` fork (e.g. `@homebridge/node-pty-prebuilt-multiarch`): trades local build complexity for trust in another publisher's binaries.
- `script`, `socat`, `ttyd`, `sshd`: move the native dependency elsewhere; `script` cannot resize cleanly behind pipes; daemons add auth and network surface.
- wterm `just-bash` or any browser-only shell: not the orb's filesystem or programs.

## Browser emulator

`OrbTerminal` uses `@wterm/react` with the DOM renderer and the `@wterm/ghostty` core, all pinned exactly to 0.5.9 (matching core dependencies). The DOM renderer gives native selection, browser find and an accessibility baseline. wterm's own `WebSocketTransport` is not used: it reconnects and replays buffered writes.

- **Ghostty core.** The built-in wterm core destroyed cells on resize (a 180-digit line shrunk then widened lost 60 digits and its end marker); Ghostty reflows wrapped lines and keeps the cursor bottom-anchored. Cost: a 599 kB (200 kB gzip) WASM asset.
- **Asset URL.** Import `@wterm/ghostty/ghostty-vt.wasm?url` and pass it to `GhosttyCore.load()`; the package's default `new URL()` path resolves to a non-WASM response under Vite's dev optimizer. Load failures are caught at the adapter and shown in the terminal body.
- Scrollback budget 1 MiB. `autoResize={false}`: the application owns grid sizing.
- **Copy.** `@wterm/dom` renders unused cells as spaces, so native selection copied full-width padding. `OrbTerminal` owns one synchronous `copy` handler (`apps/web/src/lib/terminal-copy.ts`) that acts only when both selection endpoints are inside its `.term-grid`: it strips ASCII spaces before each newline and at the end, writes `text/plain` through `clipboardData` (works on plain HTTP) and prevents the default, which also pre-empts wterm's document handler. Everything else in the selection is untouched. Soft-wrapped rows still copy with newlines (`TODO.md`). Rejected: renderer forks, package patches, DOM mutation, a duplicate transcript, reading Ghostty's private WASM state.

## UI: header shade

**Toggle.** A bare-prompt (`>_`) icon in the orb header's action row, shown only for running orbs, inverted when open, with Open/Hide accessible names, expanded state, `aria-keyshortcuts="Meta+J"` and a shortcut tooltip. On phones it lives in the Orb actions overflow menu.

**Cmd-J** toggles the same session from the composer or the terminal. The running-orb listener captures the exact shortcut before wterm, prevents browser handling and PTY input, ignores repeats, IME composition and extra modifiers, and declines while the outgoing conversation is inert. Escape, Ctrl-J and Ctrl-L stay with terminal programs. Closing by icon or Cmd-J focuses the composer without scrolling (expanding a folded phone editor); output, socket, composer mode and draft survive. A delayed ready response never steals focus after hiding.

**Shade.** An opaque full-width overlay anchored below the orb header stack (header plus any subagent rails), portaled into that stack so the phone overflow menu closing never hides or remounts it. It never moves, resizes, remounts or scrolls history and never covers the composer. Open and hide are instant: no animation. No title bar, status word or healthy-state controls. It has a complete 1px frame whose top and left rules overlap the existing header/index rules by one pixel (`left: -1px; width: calc(100% + 1px)`), with its right edge aligned to the header. No emulator border, radius or shadow.

**Sizing** (`apps/web/src/lib/terminal-layout.ts`). Rows are 20px and columns are measured from 13px JetBrains Mono; the emulator is measured before PTY admission so the first prompt starts on row one. The initial height is at most 280px and 80% of the space between header stack and composer, rounded down to whole rows. Frame padding is outside the emulator: 30px horizontal and 26px vertical plus two frame pixels per axis. The emulator viewport is always an exact multiple of the row height with zero vertical padding, so the first and last visible rows are complete and scrollback snaps to rows (`docs/postmortems/2026-09-12-terminal-focus-and-scroll-padding.md`). Extra horizontal pixels stay padding. On very short viewports the protocol's five rows stay allocated but only complete rows are shown, with no extra scroll surface.

**Resizing.** The whole bottom edge is an invisible 8px hit target inside the frame. Dragging changes only height, in whole rows, from five rows up to the space above the composer (within 200 rows); top and width never move. During the drag only the outer preview changes; one emulator/PTY resize commits on release. Cancellation or lost capture restores the committed height without a resize; unrelated pointers cannot cancel the gesture. Pointerdown prevents focus changes and captures without focusing the target, so the shell or composer keeps focus; a keyboard-focused separator stays transparent and the frame does not thicken. The separator supports Up/Down by one row and Home/End to the bounds. The chosen height survives hide/restore for the mounted page; nothing is persisted. Header-stack growth (an expanded subagent roster), window or composer changes clamp the visible grid and resize through the same PTY path without remounting, reconnecting or touching the draft.

**Failures.** Loading/connecting text is transient. Load, connection and exit failures stay visible in the body; an ended session shows one **New terminal** action. Retrying a failed core load works even when no core was created. A stale emulator's ready callback cannot open a socket after another instance owns the ref.

**Tests.** StrictMode may open and retire a development transport before its replacement is ready. Tests synchronize on the final emulator/socket identity and prove superseded peers closed, rather than counting all pre-ready opens (`docs/postmortems/2026-09-14-terminal-retry-pre-ready.md`). The frontend fixture implements the same WebSocket contract with a deterministic binary echo. A `determined` schedule test proves concurrent opens never exceed capacity. The full-slice E2E opens a real PTY through the process or Docker backend and observes binary output and exit through both proxy hops. Runtime contract tests cover backpressure, resize, `pwd`, `$HOME`, exit/signal mapping, addon load/spawn failure and cleanup.

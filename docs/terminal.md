# Interactive orb terminal

> **Status:** Decided and implemented 2026-08-09. Open question 39 is resolved.

An interactive terminal in the orb page is feasible without adding terminal operations to `OrbHostProvider` and without making the browser contact an orb directly. The simplest provider-neutral shape is a PTY owned by the existing orb runtime, reached through a second control-plane WebSocket:

```text
wterm in OrbPage
  |
  | WS /api/v1/orbs/:orbId/terminal
  v
control-plane byte proxy
  |
  | WS /v1/terminal on the already-observed runtimeAddress
  v
orb runtime -> PTY -> /bin/bash in <work-dir>/repo
```

This works in Docker, GCE, and the local process provider because all three already run the same Node runtime and expose the same runtime HTTP address to the control plane. The PTY is created inside that runtime process, where the checkout, persistent `$HOME`, prescribed tools, broker environment, and provider-specific filesystem are already present. A future provider that can run the standard runtime image and provide an ordinary Unix PTY gets terminal support automatically. No provider-specific `exec`, SSH path, public port, Tailscale dependency, database row, or control-plane shell process is required.

Putting `exec` on `OrbHostProvider` was rejected for this feature. It would duplicate provider-specific streaming and resize behavior, make the process provider materially different from Docker/GCE, and bypass the runtime boundary that already normalizes the providers.

## wterm evaluation

The repository at `vercel-labs/wterm` was inspected at commit `5c1282d35d6ffbe03aad35cfcf2645e493da7406` and npm release 0.3.2.

wterm is a good frontend candidate:

- `@wterm/react` exposes a React `<Terminal>` with `onData`, `onResize`, `write`, focus, and automatic `ResizeObserver` sizing.
- `@wterm/dom` renders rows into the DOM, giving native selection, copy/paste, browser find, and a useful accessibility baseline.
- Its default Zig/WASM core is embedded in the package (the inspected binary is about 16 KiB), so Vite needs no WASM asset route. It supports the alternate screen, scrollback, color, wide codepoints, mouse input, focus reports, and synchronized output.
- `@wterm/ghostty` is now the selected core. It has broader VT, grapheme, and resize-reflow behavior at the cost of a 429.51 KiB fetched WASM asset and explicit asset wiring. The first implementation started with the built-in core, as proposed, and switched only after the reproducible destructive-resize defect documented below.
- The packages are Apache-2.0 and support React 19.

wterm is only the browser emulator. Its local-shell example uses `node-pty` and a custom WebSocket bridge; it does not supply a secure PTY server, session model, authorization, flow control, or a resize wire contract suitable for pi-orb. Its `WebSocketTransport` also reconnects and buffers writes generically. pi-orb uses the React renderer with its own small protocol rather than adopt that transport: reconnecting to a newly spawned shell and replaying buffered keystrokes would be surprising and potentially unsafe.

**Selection-copy defect reproduced 2026-08-26:** `@wterm/dom` materializes every terminal cell, including unused cells after each printed line, as space text inside each `.term-row`. In Chromium, a real mouse drag from the start of one short line through the end of the next therefore selects and copies the first line's padding through the full 71-column grid. The frontend fixture reproduced `frontend fixture terminal` followed by 46 spaces, a newline, and `orb@frontend:~/repo$ ` instead of the two lines trimmed to their printed lengths. Native DOM selection alone does not provide normal terminal copy semantics; corrective work is tracked in `TODO.md`.

**Upstream capability finding (2026-08-26):** checked release 0.3.2, latest npm release 0.3.4, and upstream main at `cdff1c07890ab2c5ba2efbcc1091f790dfb8f931`. None exposes copy/selection serialization or hard-vs-soft row boundaries. `TerminalCore` exposes viewport cells and scrollback physical-row lengths, but no viewport content length and no wrapped-continuation bit; the DOM renderer consequently passes the full column count as every active row's length, renders the padding as text, and relies on browser-native block-row copying. The built-in core has a transient `wrap_pending` parser flag but does not retain wrap provenance on grid or scrollback rows. libghostty retains enough logical-line state to reflow wrapped text, but wterm's Ghostty WASM/`TerminalCore` boundary does not export that row metadata. Thus wterm has the underlying state, or is the correct place to retain it, but its current public abstraction discards exactly the facts copying needs.

**Interim application decision implemented 2026-08-26:** do not change wterm upstream for now. `OrbTerminal` owns one synchronous `copy` adapter that acts only when both endpoints of a non-collapsed selection are inside its `.term-grid`. It takes the browser-selected text, removes only ASCII spaces immediately before each existing newline or the selection end, writes the result as `text/plain` through the event's `clipboardData`, and prevents the padded browser default. This works on the product's plain-HTTP origins without the async Clipboard API. Newlines, leading/embedded whitespace, non-space Unicode, selection direction, and selections extending outside the terminal remain untouched. The pure normalizer has focused tests; a real Chromium mouse drag against the frontend fixture verified that the reproduced 46 padding spaces no longer enter the copy payload. A full semantic fix was initially preferred, but the local adapter was explicitly selected as the smallest useful fix while upstream work is deferred.

This narrow fix cannot recover a logical line that wterm's block DOM has already split into soft-wrapped physical rows: those rows still copy with intervening newlines. Correcting that later belongs upstream: retain trimmed content extent and wrapped-continuation metadata for viewport and scrollback rows in `TerminalCore` and both cores, then have `@wterm/dom` serialize native selection ranges. That serializer can trim unoccupied right-side cells, join soft continuations without a separator, and insert `\n` only at hard boundaries while preserving partial endpoints, graphemes, and wide cells. A renderer fork, package patch, DOM observer/mutation, duplicate transcript, or access to Ghostty's private WASM state remains rejected.

The project is young (0.x), so version 0.3.2 is pinned by the lockfile. **Core switch decision (2026-08-09):** Chromium against the real process-provider PTY printed one marked 180-digit line at the default width, shrank the terminal to its minimum width, and restored it. The built-in core retained only 120 digits, lost the `-END` marker while narrow, and never recovered either after widening: resize had destructively discarded cells rather than reflowing them. Under the identical browser/PTY/drag sequence, Ghostty retained all 180 digits and both markers at every width, then reflowed them back on expansion. A second run with 30 output lines kept the cursor bottom-anchored through repeated two-axis expansion and contraction. This is the concrete compatibility defect that justifies Ghostty's larger asset.

Vite's production build emits Ghostty as a 429.51 KiB hashed WASM asset (129.46 KiB gzip). Although the package documentation says its default `new URL()` path works in Vite, Vite's development dependency optimizer resolved that path under `/node_modules/.vite/wasm/` and returned a non-WASM response in this application. Importing `@wterm/ghostty/ghostty-vt.wasm?url` and passing that explicit URL to `GhosttyCore.load()` works in both dev and production. Loading is caught at the adapter boundary and a failure is shown inside the terminal rather than rejecting outside React. The configured scrollback budget is 1 MiB.

## Session semantics (decided and implemented)

The first version is deliberately ephemeral:

- One terminal WebSocket owns one fresh interactive `/bin/bash --noprofile --norc` PTY. It starts in `<work-dir>/repo`, with `TERM=xterm-256color`, the runtime's authoritative `HOME`, the runtime environment, and the deliberately minimal default prompt `# `. Profile startup is skipped so provider- or image-specific root/hostname/path prompts do not consume horizontal space or expose process-provider implementation paths.
- Closing its browser connection, stopping the orb, or restarting the runtime closes the PTY and its controlling terminal. Entering `stopping` closes both agent and terminal proxies immediately, with reconciler backstop coverage after control-plane restart. There is no tmux, detachable session, terminal transcript persistence, reconnect replay, or restoration after host restart.
- A transport failure ends the session visibly. The user opens a new terminal rather than silently reconnecting to a different shell.
- Multiple browser tabs may have independent PTYs, subject to a small runtime-wide limit. They do not share input or screen state. This avoids writer arbitration and shared-terminal authorization semantics.
- Hiding the terminal panel leaves its React component and socket mounted. Leaving the orb page, stopping the orb, runtime restart, transport failure, or shell exit ends it. The normal orb live connection reports browser-tab visibility for idle-stop protection, and terminal input additionally refreshes the control plane's advisory `last_busy_at` timestamp.
- The runtime must reject terminal creation until it is ready and the checkout exists. Archived, archiving, deleting, stopped, and unavailable orbs have no terminal.

These semantics preserve filesystem work, which is the durable value, without pretending terminal screen state is durable. Detachable/shared terminals can be designed later if actual use shows they are needed.

The interactive terminal is distinct from the composer `shell` action in `docs/runtime-protocol.md`. Composer shell commands are serialized foreground operations with bounded output and persisted history, and can deliberately enter model context. Interactive PTY input/output is not agent history, is not replicated, and can run concurrently with Pi. Terminal edits and processes can race with the agent in the same checkout; this is part of the documented trusted-orb execution model.

## Terminal wire protocol (implemented)

Use a separate WebSocket subprotocol, `pi-orb.terminal.v1`, rather than adding terminal bytes to the agent live protocol. The current live path accepts text-only closed JSON frames, has history synchronization and request identity rules, and is intentionally coupled to one normalized agent session. Terminal traffic has none of those semantics and may be high-volume binary data.

Endpoint pair:

```text
WS /api/v1/orbs/:orbId/terminal  # browser-facing control plane
WS /v1/terminal                  # private runtime endpoint
```

The first browser frame is a bounded JSON text control frame:

```ts
{ v: 1, type: "terminal.open", cols: number, rows: number }
```

After acceptance:

- browser binary frames are UTF-8 terminal input;
- browser text frames are closed JSON controls, initially only `terminal.resize`;
- runtime binary frames are raw UTF-8 PTY output;
- runtime text frames are closed JSON `terminal.ready`, `terminal.exit`, and typed `terminal.error` events.

Direction plus WebSocket frame kind separates terminal bytes from controls without an escaping scheme. This avoids wterm's example-only `ESC[RESIZE:…]` sentinel, which shares a namespace with real terminal input. Dimensions are bounded to 20–500 columns and 5–200 rows, binary input frames to 64 KiB, and the runtime to four concurrent sessions.

The control-plane route mirrors the existing live route's lifecycle lookup and `OrbHostProvider.observe()` flow, then proxy frames and close signals without interpreting PTY content. Unlike the agent route it permits binary frames and does not send a `client.hello`. Future authentication belongs on the browser upgrade and the existing control-plane-to-runtime trust boundary, exactly as for the agent socket.

Both proxy hops enforce a 1 MiB buffered-output ceiling and close the session with a visible typed error when a consumer is too slow; the proxy also bounds queued/input traffic. Input and resize processing is serial per PTY. Terminal output must never enter application logs, lifecycle events, PostgreSQL, or error payloads because it commonly contains source, credentials, and escape sequences.

## Runtime and packaging work

A real terminal requires a Unix PTY; ordinary `child_process.spawn()` pipes are not sufficient for interactive programs, job control, terminal modes, or resize. Something eventually has to call the platform's `forkpty`/`openpty` and `ioctl(TIOCSWINSZ)` APIs, but it does not have to be a native Node package.

### Implemented adapter: official `node-pty`

The runtime uses official `node-pty` 1.1.0 behind a narrow Result-returning TypeScript adapter. Its API directly matches the feature: `spawn`, `write`, `resize`, output/exit callbacks, and `kill`. This avoids a helper executable and an internal framing protocol; terminal bytes remain in the Node process until the WebSocket boundary. Third-party imports, calls, and callbacks must be caught at the immediate adapter boundary and mapped to typed terminal errors. Load the module through that fallible adapter rather than a top-level import so a missing/broken native binding produces a visible terminal error instead of crash-looping the entire runtime before health can answer.

The incremental complexity is concentrated in packaging rather than terminal behavior:

- **Runtime package:** `node-pty` is an approved lifecycle-script dependency in the root package and lockfile. The adapter/manager is ordinary TypeScript; `node-pty` owns PTY allocation, resize, and exit translation.
- **Linux runtime image:** official 1.1.0 has no Linux prebuild in its npm tarball. The image already ships Python, `build-essential`, and `pkg-config` for the prescribed Rust/native build baseline, so its existing dependency stage keeps `npm ci --ignore-scripts`, explicitly removes `node_modules/node-pty/prebuilds`, runs the sole reviewed `npm rebuild node-pty`, and executes a build-time PTY spawn smoke check. Removing `prebuilds` both forces the package's install check down its `node-gyp rebuild` path and discards roughly 58 MiB of irrelevant Darwin/Windows binaries. The package is about 64 MiB unpacked otherwise; the resulting Linux addon itself measured 67,392 bytes. The package's documented `npm_config_build_from_source=true` switch also worked, but npm 11 warns that this unknown environment config will stop working in the next major version, so the explicit removal is less version-fragile.
- **Architectures:** the addon is built inside Docker for the selected image target. `infra/build-push.sh` already forces production to `linux/amd64`; an Apple-Silicon local Docker build produces Linux arm64 unless overridden. No host addon is copied into an image.
- **macOS process development:** the package already includes Darwin arm64 and x64 binaries plus `spawn-helper`; ordinary root `npm ci` (scripts enabled today) normally needs no Xcode/compiler. `node_modules` becomes platform-specific and must be reinstalled rather than copied between macOS/Linux or architectures.
- **Linux process development and CI:** because official `node-pty` has no Linux prebuild, root `npm ci` needs Python 3, `make`, a C/C++ compiler, libc development headers (including `libutil`), and npm's `node-gyp`; Node headers are obtained by `node-gyp`. On Debian/Ubuntu the complete OS-side requirement is `python3` plus `build-essential` (`build-essential` pulls in `make`, `gcc`, `g++`, `libc6-dev`, and `dpkg-dev`); no Rust, CMake, or `pkg-config` is required by `node-pty` 1.1.0. The evaluated container-restricted process-development environment has Python 3, npm/`node-gyp`, CA certificates, and network access; `build-essential` was installed and validated before implementation. Both GitHub workflows explicitly install the prerequisites rather than depending on runner contents. Making the dependency optional would preserve install but silently make terminal support provider/environment-dependent and is not the recommended contract.
- **Native risk:** a malformed addon or native crash can take down the runtime process. Pin and review the package, exercise the actual compiled artifact in the image boot gate, and dynamically contain ordinary load/call failures. A segmentation fault cannot be converted to a Result.

**Build validation (2026-08-09).** The current Debian 12 development orb installed `build-essential` successfully (42 packages, 66.4 MiB downloaded, 266 MiB installed; Python 3 was already present). The implemented image workflow—install `node-pty@1.1.0` with scripts disabled, remove its cross-platform `prebuilds`, then explicitly `npm rebuild node-pty`—compiled and loaded under Node 24.19.0/npm 11.17.0 on linux/amd64. A real PTY smoke test spawned Bash, resized it to 132 columns × 41 rows (`stty size` returned `41 132`), exchanged output, and propagated exit code 0. A separate test propagated exit code 7. This establishes toolchain sufficiency and the native API path in this environment; it does not replace Docker/macOS or descendant-cleanup E2E.

The runtime owns a terminal manager that enforces the four-session limit, reserves capacity synchronously across async addon loading, tracks PTYs, exposes close reasons, and closes every PTY during Fastify/runtime shutdown. Contract tests cover input/output backpressure, resize, `pwd`, `$HOME`, exit/signal mapping, addon load/spawn failure, and cleanup. For the process provider in particular, stopping or killing the runtime must leave no PTY shell or foreground child behind; that provider has no container/cgroup boundary. Run that cleanup smoke test on Linux and macOS.

### Rejected alternatives

- **Python standard-library helper.** Technically sound and experimentally proved to create and resize a Bash PTY, but it makes Python a process-host prerequisite and introduces a first-party binary framing, partial-I/O, signal, and cleanup protocol. Rejected 2026-08-09 in favor of accepting `node-pty`'s localized native build complexity.
- **A prebuilt `node-pty` fork.** The inspected `@homebridge/node-pty-prebuilt-multiarch` 0.14.1 covers Linux glibc/musl x64 and arm64 through Node ABI 147, but replaces local build complexity with trust in another publisher's native binaries.
- **`script`, `socat`, `ttyd`, `sshd`, or a similar executable.** These merely move the native dependency to an OS package/service. `script` can allocate a PTY but does not give the Node parent a clean, portable resize/control API when its own stdio is a pipe; injecting `stty` commands fails for full-screen foreground programs. The daemons add authentication, configuration, and another network/process surface.
- **Plain shell pipes.** Adequate for the existing non-interactive composer shell operation, not an interactive terminal: no controlling terminal, terminal modes, job control, reliable signals, or full-screen resize.
- **wterm `just-bash` or another browser-only shell.** It would operate on an in-browser virtual filesystem and process model, not the orb checkout and programs, so it is not an orb terminal.

## UI direction (selected and implemented 2026-08-09)

The selected direction from a five-way exploration (`design-prototypes/terminal-integration.html`) is the **floating field console**, refined in the working interaction mockup at `design-prototypes/floating-terminal-mockup.html`. On a running orb, the terminal is a floating window anchored permanently to the bottom-right of the orb workspace, immediately above the sticky composer so it never covers the message box; it is not draggable. Its top-left corner is the sole resize hit target, with no persistent resize glyph or exterior ornament, so dragging that invisible corner target changes width and height while the bottom-right anchor never moves. Resize snaps both axes to whole terminal character-cell boundaries rather than arbitrary pixels, and each snapped step updates the PTY dimensions. Conservative minimum dimensions keep the controls and useful terminal area intact.

The title bar has an explicit minimise button. Minimising leaves the React component, WebSocket, and PTY session mounted and replaces the window with the small bordered `terminal` text button anchored at the exact bottom-right position the window occupied, and activating it restores and focuses the same session. The former `>_` glyph launcher was retired on 2026-09-04 with the Signal / Boards redesign (`docs/web-ui.md`): the UI has one face and no picture-words, so the launcher says what it opens. The console has no footer/status strip; terminal type, dimensions, and ephemeral-state chrome were rejected as clutter. Connection and session-ended errors render inside the terminal body, and an ended session exposes one explicit new-terminal action. The floating window may cover transcript content by design rather than reflowing the manuscript, but must never cover the composer; the user can hide or resize it immediately. On narrow screens it expands to nearly the available width, remains anchored above the composer, and disables corner resizing rather than presenting an unusable touch target.

**Presentation revised 2026-09-04.** The window is white on the application's ground inside a 1px black border, with an inverted black title bar carrying the uppercase `TERMINAL` label, the connection status word, and the clear/restart and minimise actions as 20px icon buttons at its right; the earlier dark ink console, its warm palette, and its shadows retired with the Reading Room design. The `>_` symbol and the hardcoded `bash · /workspace/repo` path are gone: neither was real data. Type metrics are unchanged — compact 12 px monospace, 18.6 px rows, 13 × 15 px screen padding — and the title bar is 20 px on the application's line grid rather than the mockup's 38 px, which the layout math reads from one `HEADER_HEIGHT` constant. The orb page reserves the full remaining viewport for sparse transcripts so the sticky composer is at the window bottom before any scrolling occurs; the terminal's bottom offset follows the measured composer height. The emulator is measured and sized before the PTY opens, so a fresh prompt starts at the first row rather than being bottom-anchored after an initial 80×24 resize. The initial outer panel is then snapped from that measured grid with the same whole-cell invariant as interactive resize; the prototype pixel dimensions are only a measurement starting point. This is required for reliable follow-tail behavior: in Chromium, the old 391 px prototype height let flex layout stretch wterm's 349 px locked viewport to 351 px, so its row-aligned bottom calculation left a 17 px gap when the first 19 px scrollback row arrived and then misclassified the view as manually scrolled up. Snapping the panel to 389 px restored a zero-pixel bottom gap through repeated output (verified 2026-08-10). During corner dragging only the panel changes size; one snapped emulator/PTY resize is committed on pointer release, avoiding wterm scroll/reflow races on every pointer event. Product documentation defines the session as ephemeral and separate from conversation history; no persistent footer repeats that information.

The frontend-only fixture implements the same terminal WebSocket contract with deterministic binary echo and prompt behavior; it does not use wterm's in-browser `just-bash`. The full-slice E2E opens a real PTY through the process or Docker backend, executes a command, observes binary output and exit through both proxy hops, then continues through the ordinary agent/history/drain flow. Admission has a `determined` schedule test proving concurrent opens never exceed capacity.

## Implementation boundaries

The feature consists of shared terminal schemas/constants, a runtime PTY manager and `/v1/terminal` route, a binary-capable control-plane proxy, the wterm floating UI, fixture support, and unit/DST/E2E coverage. The provider interface, database schema, history model, lifecycle state machine, Tailscale port exposure, and agent live protocol did not change. The two decisions most likely to expand the scope are choosing detachable/shared terminal persistence and making PTY foreground activity itself a durable lifecycle signal; neither is recommended for the first version.

# Control-plane Node header download failure

## First failure (2026-10-15, PDT)

PR 112 source `00bb427887f368278007c862221f4fc96bb9e62a`,
[CI 38782099538, job 116584732489](https://github.com/schani/pi-orb/actions/runs/38782099538/job/116584732489),
failed during `npm rebuild node-pty`, after installation and patching succeeded.
Node 24.22.0 / node-gyp 12.4.0 requested Node headers, received HTTP 200,
then npm-bundled Undici's HTTP/1 `Parser.finish` asserted `!this.paused` on TLS end.
The failure was in header acquisition, before native compilation; the underlying
transport/parser trigger is not established.

Full first log retained at
`.context/cross-orb/substantial112-contract/ci-observed/112-control-plane-image-failure.log`.

## Decision (2026-10-15, PDT)

Use the official Node image's matching binary and headers under `/usr/local`.
After installation and patching, a separate `RUN --network=none` removes PTY
prebuilds and runs `npm_config_nodedir=/usr/local npm rebuild node-pty` followed
by the existing PTY spawn smoke. Keep the final-image smoke unchanged.
This removes header-download dependence instead of retrying the assertion,
upgrading dependencies, or increasing timeouts. Build and smoke failures remain
visible in Docker/Actions logs. Invariant: `docs/deployment.md`.

## Evidence and limits

Inspected node-gyp 12.4.0 source bypasses header download when `nodedir` is set.
The environment key also works with installed node-gyp 11.2.0.
An isolated actual native-addon probe under `.context/babysit-112/probe/` failed
without `nodedir` against dead HTTP port 9 (`red.log`); with
`npm_config_nodedir=/usr/local` and the same dead URL it compiled without HTTP
(`green.log`) and loaded `answer=42` (`load.log`). That probe used Node 24.6.0 /
node-gyp 11.2.0, not CI's versions, and was not a Docker or node-pty build.

The focused Dockerfile contract was red before the fix and green afterward;
receipts: `.context/babysit-112/receipts/contract-{red,green}.log`.
It protects offline step boundaries, header selection and the spawn smoke,
not native execution. No Docker daemon was available locally; authoritative
image build and both PTY smokes require fresh exact-source CI after parent push.
No image/release qualification or hosted recovery is claimed here.

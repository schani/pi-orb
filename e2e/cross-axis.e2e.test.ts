import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, expect as expectPage } from "@playwright/test";
import { build } from "vite";
import { expect, test } from "vitest";
import { parseDockerLoopbackPort } from "./docker-port.ts";
import {
  api,
  createFakeSession,
  deleteFakeSession,
  docker,
  FatalProbeError,
  fakeControl,
  orbContainerNames,
  removeOrbContainers,
  startControlPlane,
  waitFor,
  waitForPostgres,
} from "./harness.ts";
import {
  CROSS_AXIS_CASES,
  issuedDeviceLoginChallenge,
  localGitEnvironment,
} from "./testkit/cross-axis.ts";

const URL = "https://github.com/schani/pi-orb";
const stop = { type: "stop", reason: "stop" };
const git = (repository: string, ...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port allocation");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

for (const composition of CROSS_AXIS_CASES) {
  const provider = process.env["PI_ORB_E2E_BACKEND"] === "process" ? "process" : "docker";
  test.runIf(composition.provider === provider)(
    `${composition.agentBackend}+${composition.provider}: fresh checkout, real host tool, browser, CLI${composition.movingMain ? ", moving main and dirty resume" : ""}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-orb-cross-axis-"));
      const evidence = join(
        process.env["PI_ORB_E2E_EVIDENCE_DIR"] ?? join(import.meta.dirname, "../test-failures"),
        `cross-axis-${composition.agentBackend}-${composition.provider}-${randomUUID()}`,
      );
      mkdirSync(evidence, { recursive: true });
      const project = randomUUID();
      const orb = randomUUID();
      const repo = join(root, "source");
      const hosts = join(root, "hosts");
      const guestRepo = join(hosts, orb, "workspace", "repo");
      const central = composition.agentBackend === "central-durable";
      const local = composition.provider === "process";
      const pgName = `cross-axis-pg-${randomUUID()}`;
      const network = `cross-axis-${randomUUID()}`;
      let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
      let browser: Browser | undefined;
      let gateResponse: ServerResponse | undefined;
      let resolvedSha: string | undefined;
      let released = !composition.movingMain;
      const gate = createServer((request, response) => {
        resolvedSha =
          new globalThis.URL(request.url ?? "/", "http://fixture").searchParams.get("commitSha") ??
          undefined;
        gateResponse = response;
        if (released) response.end("released");
      });
      await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
      const gateAddress = gate.address();
      if (!gateAddress || typeof gateAddress === "string") throw new Error("missing gate");
      let pinA: string | undefined;
      if (local) {
        mkdirSync(join(repo, ".agents"), { recursive: true });
        writeFileSync(join(repo, "tracked.txt"), "COMMIT_A\n");
        writeFileSync(join(repo, "AGENTS.md"), "Fixture repository.\n");
        writeFileSync(join(repo, ".agents/setup"), "#!/bin/sh\ngit rev-parse HEAD > setup-head\n", {
          mode: 0o755,
        });
        writeFileSync(
          join(repo, ".agents/resume"),
          "#!/bin/sh\ngit rev-parse HEAD >> resume-heads\n",
          { mode: 0o755 },
        );
        execFileSync("git", ["init", "-q", "-b", "main", repo]);
        git(repo, "add", ".");
        git(
          repo,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-qm",
          "A",
        );
        pinA = git(repo, "rev-parse", "HEAD");
        expect(existsSync(guestRepo), "fresh workspace checkout must initially be absent").toBe(
          false,
        );
      }
      const shell =
        "set -eu; printf CROSS_AXIS_HOST_TOOL; pwd; git rev-parse HEAD; printf CROSS_AXIS_FILE > cross-axis-smoke.txt; pi-orb self --json > cross-axis-self.json; cat cross-axis-self.json; printf CROSS_AXIS_CLI_OK";
      const fake = await createFakeSession(
        `cross-axis-${randomUUID()}`,
        {
          auth: { accountId: "cross-axis", device: { manualApprove: true } },
          model: {
            rules: [
              {
                match: { userMessage: { regex: "^CROSS_AXIS_TURN$" } },
                steps: [
                  {
                    type: "toolCall",
                    name: central ? "codemode" : "bash",
                    arguments: central
                      ? { code: `text(await tools.bash({command:${JSON.stringify(shell)}}));` }
                      : { command: shell },
                  },
                  stop,
                ],
              },
              ...(central
                ? [
                    {
                      match: {
                        toolResultContains: { regex: "Host instructions adopted; re-evaluate" },
                      },
                      steps: [
                        {
                          type: "toolCall",
                          name: "codemode",
                          arguments: {
                            code: `text(await tools.bash({command:${JSON.stringify(shell)}}));`,
                          },
                        },
                        stop,
                      ],
                    },
                  ]
                : []),
              {
                match: { toolResultContains: { regex: "CROSS_AXIS_HOST_TOOL" } },
                steps: [{ type: "text", content: "CROSS_AXIS_DONE" }, stop],
              },
              {
                match: {
                  userMessage: { regex: "^Write a single short desktop-notification sentence" },
                },
                steps: [{ type: "text", content: "Verified host execution." }, stop],
              },
              {
                match: { userMessage: { regex: "^CROSS_AXIS_BROWSER$" } },
                steps: [{ type: "text", content: "CROSS_AXIS_BROWSER_DONE" }, stop],
              },
              {
                match: {
                  userMessage: { regex: "^Write a single short desktop-notification sentence" },
                },
                steps: [{ type: "text", content: "Verified browser input." }, stop],
              },
            ],
          },
        },
        composition.agentBackend,
      );
      const nameFake = await createFakeSession(
        `cross-axis-names-${randomUUID()}`,
        {
          model: {
            rules: [
              { match: { default: true }, steps: [{ type: "text", content: "Fixture" }, stop] },
            ],
          },
        },
        composition.agentBackend,
      );
      let pgStarted = false;
      let networkCreated = false;
      let failed = true;
      try {
        const webRoot = join(import.meta.dirname, "../apps/web");
        await build({
          root: webRoot,
          configFile: join(webRoot, "vite.config.ts"),
          logLevel: "silent",
          build: { outDir: join(root, "web"), emptyOutDir: true },
        });
        let databaseUrl: string | undefined;
        if (!local) {
          await docker(["network", "create", network]);
          networkCreated = true;
          await docker([
            "run",
            "--detach",
            "--name",
            pgName,
            "-e",
            "POSTGRES_USER=pi-orb",
            "-e",
            "POSTGRES_PASSWORD=pi-orb",
            "-e",
            "POSTGRES_DB=pi_orb",
            "-p",
            "127.0.0.1::5432",
            "postgres:16",
          ]);
          pgStarted = true;
          await waitForPostgres(pgName, "pi-orb", "pi_orb");
          const port = parseDockerLoopbackPort(await docker(["port", pgName, "5432/tcp"]));
          if (port.isErr()) throw new Error("invalid postgres port");
          databaseUrl = `postgres://pi-orb:pi-orb@127.0.0.1:${port.value}/pi_orb`;
        }
        cp = await startControlPlane({
          port: await unusedPort(),
          fake,
          nameFake,
          agentBackend: composition.agentBackend,
          ...(local
            ? { pglitePath: join(root, "db"), processStateDirectory: hosts }
            : {
                databaseUrl: databaseUrl ?? "",
                dockerNetwork: network,
                runtimeImage: "pi-orb-runtime:dev",
              }),
          authDir: join(root, "auth"),
          hostingRoot: join(root, "hosting"),
          webDist: join(root, "web"),
          ...(central ? { entry: "e2e/cross-axis-control-plane-entry.ts" } : {}),
          extraEnv: {
            ...(local && central ? localGitEnvironment(repo, URL) : {}),
            ...(local && central
              ? {
                  PI_ORB_E2E_RESOURCE_REPOSITORY: repo,
                  PI_ORB_E2E_RESOLVED_GATE: `http://127.0.0.1:${gateAddress.port}/resolved`,
                }
              : {}),
          },
        });
        const baseUrl = cp.baseUrl;
        expect(
          (
            await api(cp.baseUrl, "POST", "/api/v1/projects", {
              id: project,
              name: "Cross axis",
              repositoryUrl: URL,
            })
          ).status,
        ).toBe(201);
        expect(
          (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
        ).toBe(202);
        expect(
          (
            await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
              content: [{ type: "text", text: "CROSS_AXIS_TURN" }],
            })
          ).status,
        ).toBe(202);
        const challenge = await waitFor(
          "backend model login",
          async () => {
            const action = (await api(baseUrl, "GET", `/api/v1/orbs/${orb}`)).body[
              "actionRequired"
            ] as { type?: string; userCode?: string } | undefined;
            return issuedDeviceLoginChallenge(action);
          },
          { timeoutMs: 60_000 },
        );
        // Only test-owned mock credentials are retained here.
        writeFileSync(
          join(evidence, "login-challenge.json"),
          JSON.stringify({
            action: challenge,
            sessionKey: fake.sessionKey,
            oauthBaseUrl: fake.oauthBaseUrl,
            inferenceBaseUrl: fake.inferenceBaseUrl,
          }),
        );
        writeFileSync(
          join(evidence, "login-ledger-before-approve.json"),
          JSON.stringify(await fakeControl(fake.sessionKey, "/requests")),
        );
        await fakeControl(fake.sessionKey, "/deviceauth/approve", {
          user_code: challenge.userCode,
        });
        let beforePin:
          | {
              specFingerprint: string;
              incarnation: number;
              supervisorId: string;
              processGroupId: number;
              processBirth: string;
            }
          | undefined;
        if (composition.movingMain) {
          await waitFor("commit A acquired before publication", async () =>
            resolvedSha ? true : null,
          );
          expect(resolvedSha).toBe(pinA);
          await waitFor("production provisioning launches pin-waiting fresh guest", async () => {
            const path = join(hosts, orb, "host.json");
            if (!existsSync(path)) return null;
            const metadata = JSON.parse(readFileSync(path, "utf8"));
            return metadata.processGroupId && metadata.processBirth ? true : null;
          });
          beforePin = JSON.parse(readFileSync(join(hosts, orb, "host.json"), "utf8"));
          expect(
            existsSync(guestRepo),
            "guest must not clone moving main before pin publication",
          ).toBe(false);
          expect(cp.modelRequests).toHaveLength(0);
          writeFileSync(join(repo, "tracked.txt"), "COMMIT_B\n");
          git(repo, "add", ".");
          git(
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "B",
          );
          expect(git(repo, "rev-parse", "main")).not.toBe(pinA);
          released = true;
          gateResponse?.end("publish A after main advanced to B");
        }
        await waitFor(
          "actual guest running",
          async () => {
            const view = await api(baseUrl, "GET", `/api/v1/orbs/${orb}`);
            writeFileSync(join(evidence, "view.json"), JSON.stringify(view.body));
            if (view.body["state"] === "failed")
              throw new FatalProbeError(JSON.stringify(view.body));
            return view.body["state"] === "running" ? true : null;
          },
          { timeoutMs: 300_000 },
        );
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`);
        expect(view.body["centralAgent"] === true).toBe(central);
        let token: string;
        let incarnation: number;
        let runtimeBase: string;
        if (local) {
          const metadata = JSON.parse(readFileSync(join(hosts, orb, "host.json"), "utf8"));
          token = metadata.runtimeToken;
          incarnation = metadata.incarnation;
          runtimeBase = `http://127.0.0.1:${metadata.port}`;
          const command = readFileSync(`/proc/${metadata.processGroupId}/cmdline`, "utf8");
          expect(command).toContain("/runtime-entry.ts");
          expect(
            readFileSync(`/proc/${metadata.processGroupId}/environ`, "utf8").split("\0"),
          ).toContain(`PI_ORB_RUNTIME_MODE=${central ? "execution" : "pi"}`);
          if (beforePin) {
            expect(metadata).toMatchObject({
              specFingerprint: beforePin.specFingerprint,
              incarnation: beforePin.incarnation,
              supervisorId: beforePin.supervisorId,
              processGroupId: beforePin.processGroupId,
              processBirth: beforePin.processBirth,
            });
            expect(git(guestRepo, "rev-parse", "HEAD")).toBe(pinA);
            expect(readFileSync(join(guestRepo, "setup-head"), "utf8").trim()).toBe(pinA);
          }
        } else {
          const names = await docker([
            "ps",
            "--filter",
            `label=pi-orb.orb-id=${orb}`,
            "--format",
            "{{.Names}}",
          ]);
          const container = names.trim();
          expect(container).toMatch(new RegExp(`^pi-orb-${orb}-i\\d+$`));
          const environment = JSON.parse(
            await docker(["inspect", container, "--format", "{{json .Config.Env}}"]),
          ) as string[];
          expect(environment).toContain("PI_ORB_RUNTIME_MODE=execution");
          token =
            environment
              .find((value) => value.startsWith("PI_ORB_RUNTIME_TOKEN="))
              ?.slice("PI_ORB_RUNTIME_TOKEN=".length) ?? "";
          incarnation = Number(container.split("-i").at(-1));
          const port = parseDockerLoopbackPort(await docker(["port", container, "8080/tcp"]));
          if (port.isErr()) throw new Error("invalid runtime port");
          runtimeBase = `http://127.0.0.1:${port.value}`;
        }
        const headers = {
          authorization: `Bearer ${token}`,
          "x-orb-incarnation": String(incarnation),
        };
        const ready = await fetch(`${runtimeBase}/execution/ready`, { headers });
        expect(ready.status).toBe(central ? 200 : 404);
        if (central) {
          const resources = (await ready.json()) as {
            cwd: string;
            incarnation: string;
            checkoutCommit: string;
          };
          expect(resources.cwd).toBe(local ? guestRepo : "/workspace/repo");
          expect(resources.incarnation).toBe(String(incarnation));
          expect(resources.checkoutCommit).toMatch(/^[a-f0-9]{40}$/);
          writeFileSync(join(evidence, "execution-ready.json"), JSON.stringify(resources));
        }
        if (central) {
          const pin = await fetch(`${cp.baseUrl}/api/runtime/initial-checkout`, { headers });
          expect(pin.status).toBe(200);
          const persisted = (await pin.json()) as { commitSha: string };
          const head = local
            ? git(guestRepo, "rev-parse", "HEAD")
            : (
                await docker([
                  "exec",
                  `pi-orb-${orb}-i${incarnation}`,
                  "git",
                  "-C",
                  "/workspace/repo",
                  "rev-parse",
                  "HEAD",
                ])
              ).trim();
          expect(persisted.commitSha).toBe(head);
          if (pinA) expect(persisted.commitSha).toBe(pinA);
          writeFileSync(
            join(evidence, "pin.json"),
            JSON.stringify({
              persistedSha: persisted.commitSha,
              guestHead: head,
              fixtureMain: local ? git(repo, "rev-parse", "main") : null,
              freshCheckoutInitiallyAbsent: local,
            }),
          );
        }
        await waitFor("real model tool round trip committed", async () => {
          const history = await api(baseUrl, "GET", `/api/v1/orbs/${orb}/history`);
          writeFileSync(join(evidence, "history.json"), JSON.stringify(history.body));
          const text = JSON.stringify(history.body);
          return text.includes("CROSS_AXIS_DONE") &&
            text.includes("CROSS_AXIS_HOST_TOOL") &&
            text.includes("CROSS_AXIS_CLI_OK") &&
            text.includes(orb)
            ? true
            : null;
        });
        await waitFor("first turn summary consumed before browser input", async () => {
          const recorded: unknown = await fakeControl(fake.sessionKey, "/requests");
          return Array.isArray(recorded) &&
            recorded.some(
              (request) => request.status === 200 && request.matchedRuleIndex === (central ? 3 : 2),
            )
            ? true
            : null;
        });
        const smoke = local
          ? readFileSync(join(guestRepo, "cross-axis-smoke.txt"), "utf8")
          : await docker([
              "exec",
              `pi-orb-${orb}-i${incarnation}`,
              "cat",
              "/workspace/repo/cross-axis-smoke.txt",
            ]);
        expect(smoke).toBe("CROSS_AXIS_FILE");
        const self = JSON.parse(
          local
            ? readFileSync(join(guestRepo, "cross-axis-self.json"), "utf8")
            : await docker([
                "exec",
                `pi-orb-${orb}-i${incarnation}`,
                "cat",
                "/workspace/repo/cross-axis-self.json",
              ]),
        );
        expect(self).toMatchObject({
          orb: { id: orb },
          project: { id: project, repositoryUrl: URL },
        });
        writeFileSync(join(evidence, "cli-self.json"), JSON.stringify(self));
        browser = await chromium.launch({
          ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
          args: ["--no-sandbox"],
        });
        const page = await browser.newPage();
        let welcome: { orbId: string; capabilities: string[] } | undefined;
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            const text = typeof payload === "string" ? payload : payload.toString();
            if (text.includes('"server.welcome"')) welcome = JSON.parse(text);
          });
        });
        await page.goto(`${cp.baseUrl}/orbs/${orb}`);
        await expectPage(page.getByText("CROSS_AXIS_DONE", { exact: true })).toBeVisible();
        await expectPage(
          page.getByRole("button", { name: "Change model", exact: true }),
        ).toBeEnabled();
        await waitFor("actual browser runtime welcome", async () => welcome ?? null);
        expect(welcome).toMatchObject({
          orbId: orb,
          capabilities: expect.arrayContaining(["abort", "input.image"]),
        });
        writeFileSync(join(evidence, "browser-welcome.json"), JSON.stringify(welcome));
        await page
          .getByRole("textbox", { name: "Message the orb", exact: true })
          .fill("CROSS_AXIS_BROWSER");
        await page
          .getByRole("textbox", { name: "Message the orb", exact: true })
          .press("Control+Enter");
        await waitFor("browser-submitted turn committed", async () =>
          JSON.stringify((await api(baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body).includes(
            "CROSS_AXIS_BROWSER_DONE",
          )
            ? true
            : null,
        );
        await expectPage(page.getByText("CROSS_AXIS_BROWSER_DONE", { exact: true })).toBeVisible();
        await page.reload();
        await expectPage(page.getByText("CROSS_AXIS_DONE", { exact: true })).toBeVisible();
        await expectPage(page.getByText("CROSS_AXIS_BROWSER_DONE", { exact: true })).toBeVisible();
        await browser.close();
        browser = undefined;
        if (composition.movingMain) {
          writeFileSync(join(guestRepo, "tracked.txt"), "RETAINED_DIRTY\n");
          const setup = readFileSync(join(guestRepo, "setup-head"), "utf8");
          const resume = readFileSync(join(guestRepo, "resume-heads"), "utf8");
          expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/stop`)).status).toBe(202);
          await waitFor("stopped before retained resume", async () =>
            (await api(baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "stopped"
              ? true
              : null,
          );
          expect((await api(cp.baseUrl, "POST", `/api/v1/orbs/${orb}/start`)).status).toBe(202);
          await waitFor(
            "retained dirty resume running",
            async () =>
              (await api(baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"] === "running"
                ? true
                : null,
            { timeoutMs: 300_000 },
          );
          expect(git(guestRepo, "rev-parse", "HEAD")).toBe(pinA);
          expect(readFileSync(join(guestRepo, "tracked.txt"), "utf8")).toBe("RETAINED_DIRTY\n");
          expect(git(guestRepo, "status", "--porcelain")).toMatch(/^ ?M tracked\.txt$/m);
          expect(readFileSync(join(guestRepo, "setup-head"), "utf8")).toBe(setup);
          expect(readFileSync(join(guestRepo, "resume-heads"), "utf8")).toBe(`${resume}${pinA}\n`);
        }
        writeFileSync(
          join(evidence, "result.json"),
          JSON.stringify({ composition, outcome: "passed" }),
        );
        failed = false;
      } catch (cause) {
        writeFileSync(join(evidence, "failure.txt"), String(cause));
        throw cause;
      } finally {
        if (cp) writeFileSync(join(evidence, "control-plane.log"), cp.logs.join(""));
        if (cp?.modelRequests)
          writeFileSync(join(evidence, "relay-requests.json"), JSON.stringify(cp.modelRequests));
        await browser?.close();
        gateResponse?.end("teardown");
        gate.closeAllConnections();
        await new Promise<void>((resolve) => gate.close(() => resolve()));
        await cp?.stop();
        if (!local) {
          if (failed) {
            const names = await orbContainerNames(orb);
            for (const name of names) await docker(["stop", name]);
            if (pgStarted) await docker(["stop", pgName]);
            writeFileSync(
              join(evidence, "retained-docker.json"),
              JSON.stringify({
                containers: names,
                postgres: pgStarted ? pgName : null,
                network: networkCreated ? network : null,
                workspaceVolume: `pi-orb-data-${orb}`,
              }),
            );
          } else {
            await removeOrbContainers(orb);
            await docker(["volume", "rm", "-f", `pi-orb-data-${orb}`]);
            if (pgStarted) await docker(["rm", "-f", pgName]);
            if (networkCreated) await docker(["network", "rm", network]);
          }
        }
        writeFileSync(
          join(evidence, "model-requests.json"),
          JSON.stringify(await fakeControl(fake.sessionKey, "/requests")),
        );
        await deleteFakeSession(fake.sessionKey);
        await deleteFakeSession(nameFake.sessionKey);
        // Keep this test-owned DB/workspace for first-failure diagnosis; never user state.
        writeFileSync(join(evidence, "fixture-root.txt"), root);
      }
    },
    720_000,
  );
}

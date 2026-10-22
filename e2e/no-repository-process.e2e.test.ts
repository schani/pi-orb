import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as baseIt, expect } from "vitest";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import { runTerminal } from "./terminal-client.ts";

const it = baseIt.skipIf(process.platform !== "linux");
const stop = { type: "stop", status: "completed" };
const githubToken = "no-repository-owner-github-access";

it("name-only project runs a central first turn, owner GitHub tools and a retained workspace without a repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-no-repository-"));
  const projectId = randomUUID();
  const orbId = randomUUID();
  let cp: ControlPlaneHandle | undefined;
  let fake: FakeSession | undefined;
  let approvedGithub = false;
  const githubRequests: string[] = [];
  const github = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the owned mock request. */
    }
    response.setHeader("content-type", "application/json");
    githubRequests.push(request.url ?? "");
    if (request.url === "/login/device/code") {
      response.end(
        JSON.stringify({
          device_code: "no-repository-device",
          user_code: "NO-REPOSITORY",
          verification_uri: "https://github.test/activate",
          expires_in: 600,
          interval: 0,
        }),
      );
    } else if (request.url === "/login/oauth/access_token") {
      response.end(
        JSON.stringify(
          approvedGithub
            ? {
                access_token: githubToken,
                refresh_token: "no-repository-owner-github-refresh",
                expires_in: 3600,
              }
            : { error: "authorization_pending" },
        ),
      );
    } else if (request.url === "/user") {
      response.end(JSON.stringify({ login: "no-repository-owner" }));
    } else response.writeHead(404).end("{}");
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  const address = github.address();
  if (!address || typeof address === "string") throw new Error("Missing GitHub mock port");
  try {
    fake = await createFakeSession(`no-repository-${randomUUID()}`, {
      auth: { accountId: "no-repository-owner", device: { manualApprove: true } },
      model: {
        rules: [
          {
            match: { userMessage: { regex: "^create the repository-free workspace marker$" } },
            steps: [
              {
                type: "toolCall",
                name: "bash",
                arguments: {
                  command:
                    "test ! -e .git && test ! -e AGENTS.md && printf retained-no-repository > retained.txt && printf NO_REPO_SHELL_OK",
                },
              },
              stop,
            ],
          },
          {
            match: { toolResultContains: { regex: "NO_REPO_SHELL_OK" } },
            steps: [{ type: "text", content: "NO_REPO_FIRST_TURN_COMPLETE" }, stop],
          },
          {
            match: { default: true },
            steps: [{ type: "text", content: "Repository-free workspace" }, stop],
          },
        ],
      },
    });
    cp = await startControlPlane({
      port: 7193,
      fake,
      pglitePath: join(root, "db"),
      processStateDirectory: join(root, "hosts"),
      authDir: join(root, "auth"),
      extraEnv: {
        PI_ORB_GITHUB_CLIENT_ID: "no-repository-client",
        PI_ORB_GITHUB_CLIENT_SECRET: "no-repository-secret",
        PI_ORB_GITHUB_OAUTH_URL: `http://127.0.0.1:${address.port}`,
        PI_ORB_GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    const baseUrl = cp.baseUrl;
    const created = await api(baseUrl, "POST", "/api/v1/projects", {
      id: projectId,
      name: "No repository",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body["repositoryUrl"]).toBeNull();
    expect(
      (await api(baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, { id: orbId })).status,
    ).toBe(202);
    const view = () => api(baseUrl, "GET", `/api/v1/orbs/${orbId}`);
    const challenge = async (type: string) =>
      waitFor(type, async () => {
        const result = await view();
        if (result.body["state"] === "failed")
          throw new FatalProbeError(JSON.stringify(result.body));
        const action = result.body["actionRequired"] as
          | { type?: string; userCode?: string }
          | undefined;
        return action?.type === type && action.userCode ? action.userCode : null;
      });
    const codexCode = await challenge("openai_codex_device_login");
    expect((await view()).body["state"]).not.toBe("running");
    expect(githubRequests).toHaveLength(0);
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: codexCode });
    expect(await challenge("github_device_login")).toBe("NO-REPOSITORY");
    expect((await view()).body["state"]).not.toBe("running");
    approvedGithub = true;
    const running = () =>
      waitFor(
        "repository-free runtime running",
        async () => {
          const result = await view();
          if (result.body["state"] === "failed")
            throw new FatalProbeError(JSON.stringify(result.body));
          return result.body["state"] === "running" ? true : null;
        },
        { timeoutMs: 120_000 },
      );
    await running();
    const firstMessage = "create the repository-free workspace marker";
    expect(
      (
        await api(baseUrl, "PUT", `/api/v1/orbs/${orbId}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: firstMessage }],
        })
      ).status,
    ).toBe(202);
    await waitFor(
      "central first model turn and real shell result",
      async () => {
        const history = await api(baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
        return JSON.stringify(history.body["records"]).includes("NO_REPO_FIRST_TURN_COMPLETE")
          ? true
          : null;
      },
      { timeoutMs: 120_000 },
    );
    expect(cp.modelRequests?.some((body) => JSON.stringify(body).includes(firstMessage))).toBe(
      true,
    );

    const checkWorkspace = async () => {
      const output = await runTerminal(
        baseUrl,
        orbId,
        'test "$(cat retained.txt)" = retained-no-repository && test ! -e .git && test "$(gh auth token)" = "' +
          githubToken +
          "\" && printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | grep -q '^password=" +
          githubToken +
          "$' && printf 'NO_REPO_%s\\n' WORKSPACE_OK",
        "NO_REPO_WORKSPACE_OK",
      );
      expect(output).toContain("NO_REPO_WORKSPACE_OK");
    };
    await checkWorkspace();
    expect((await api(baseUrl, "POST", `/api/v1/orbs/${orbId}/stop`)).status).toBe(202);
    await waitFor("repository-free stopped", async () =>
      (await view()).body["state"] === "stopped" ? true : null,
    );
    const stopped = await api(baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
    expect(JSON.stringify(stopped.body["records"])).toContain("NO_REPO_FIRST_TURN_COMPLETE");
    expect((await api(baseUrl, "POST", `/api/v1/orbs/${orbId}/start`)).status).toBe(202);
    await running();
    await checkWorkspace();
    const restored = await api(baseUrl, "GET", `/api/v1/orbs/${orbId}/history`);
    expect(JSON.stringify(restored.body["records"])).toContain("NO_REPO_FIRST_TURN_COMPLETE");
  } catch (error) {
    mkdirSync(".context/no-repo", { recursive: true });
    if (cp) writeFileSync(".context/no-repo/e2e-control-plane.log", cp.logs.join(""));
    writeFileSync(".context/no-repo/e2e-github-requests.json", JSON.stringify(githubRequests));
    throw error;
  } finally {
    await cp?.stop();
    await new Promise<void>((resolve, reject) =>
      github.close((error) => (error ? reject(error) : resolve())),
    );
    if (fake) await deleteFakeSession(fake.sessionKey);
    rmSync(root, { recursive: true, force: true });
  }
}, 360_000);

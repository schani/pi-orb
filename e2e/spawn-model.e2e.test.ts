import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openControlPlaneDatabase } from "../apps/control-plane/src/adapters/database.ts";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "../apps/control-plane/src/domain/constants.ts";
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
import { issuedDeviceLoginChallenge } from "./testkit/cross-axis.ts";
import { ownedControlPlaneIngress } from "./testkit/owned-control-plane-ingress.ts";
import { ownedGitHttps } from "./testkit/owned-git-https.ts";

it
  .runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")
  .each(["central-durable", "host-pi"] as const)(
  "%s: installed spawn CLI commits initial model and first unattended inference uses it",
  async (agentBackend) => {
    const evidence = join(import.meta.dirname, "../.context/cross-orb/spawn-model/e2e");
    mkdirSync(evidence, { recursive: true });
    const root = mkdtempSync(join(evidence, `${agentBackend}-`));
    const projectId = randomUUID(),
      callerId = randomUUID(),
      childId = randomUUID();
    let cp: ControlPlaneHandle | undefined;
    let fake: FakeSession | undefined;
    let git: Awaited<ReturnType<typeof ownedGitHttps>> | undefined;
    let ingress: Awaited<ReturnType<typeof ownedControlPlaneIngress>> | undefined;
    const save = (name: string, value: unknown) =>
      writeFileSync(join(root, name), JSON.stringify(value, null, 2));
    try {
      const repository = join(root, "source");
      mkdirSync(repository);
      writeFileSync(join(repository, "README.md"), "Spawn model E2E\n");
      for (const args of [
        ["init", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=E2E", "-c", "user.email=e2e@example.test", "commit", "-m", "fixture"],
      ])
        execFileSync("git", args, { cwd: repository, stdio: "ignore" });
      git = await ownedGitHttps(repository, root);
      fake = await createFakeSession(
        `spawn-model-${childId}`,
        {
          auth: { accountId: childId, device: { manualApprove: true } },
          model: {
            rules: [
              {
                match: { userMessage: { regex: "^SPAWN_MODEL_FIRST_TURN$" } },
                steps: [
                  { type: "text", content: "SPAWN_MODEL_COMPLETED" },
                  { type: "stop", status: "completed" },
                ],
              },
              {
                match: {
                  userMessage: { regex: "^Write a single short desktop-notification sentence" },
                },
                steps: [
                  { type: "text", content: "Completed model task." },
                  { type: "stop", status: "completed" },
                ],
              },
            ],
          },
        },
        agentBackend,
      );
      const db = openControlPlaneDatabase({
        kind: "pglite",
        path: join(root, "db"),
      })._unsafeUnwrap();
      (await db.migrate())._unsafeUnwrap();
      (await db.close())._unsafeUnwrap();
      ingress = await ownedControlPlaneIngress();
      const base = ingress.baseUrl;
      cp = await startControlPlane({
        port: 0,
        controlledClockEpoch: Date.now(),
        fake,
        agentBackend,
        resourceRepository: repository,
        pglitePath: join(root, "db"),
        authDir: join(root, "auth"),
        processStateDirectory: join(root, "hosts"),
        hostingRoot: join(root, "hosting"),
        readinessHeaders: { host: new URL(base).host },
        extraEnv: {
          PI_ORB_APP_ORIGIN: base,
          PI_ORB_BROKER_URL: base,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${git.baseUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/e2e/spawn-model",
          GIT_SSL_CAINFO: git.cert,
        },
      });
      ingress.connect(cp.baseUrl);
      expect(
        (
          await api(base, "POST", "/api/v1/projects", {
            id: projectId,
            name: "Spawn model",
            repositoryUrl: "https://github.com/e2e/spawn-model",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await api(base, "POST", `/api/v1/projects/${projectId}/orbs`, {
            id: callerId,
            name: "Model caller",
            userTimeZone: "America/Los_Angeles",
          })
        ).status,
      ).toBe(202);
      const view = (id: string) => api(base, "GET", `/api/v1/orbs/${id}`);
      const code = await waitFor("caller device challenge", async () => {
        const action = (await view(callerId)).body["actionRequired"] as
          | { type?: string; userCode?: string }
          | undefined;
        return issuedDeviceLoginChallenge(action)?.userCode ?? null;
      });
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      await waitFor("caller execution ready", async () => {
        const response = await view(callerId);
        if (response.body["state"] === "failed")
          throw new FatalProbeError(JSON.stringify(response.body));
        return response.body["state"] === "running" ? true : null;
      });
      const command = `pi-orb spawn --id ${childId} --prompt SPAWN_MODEL_FIRST_TURN --name Model-child --model Astra --json`;
      const output = await runTerminal(
        cp.baseUrl,
        callerId,
        `${command}; printf '\\123\\120\\101\\127\\116\\137\\104\\117\\116\\105\\012'`,
        "SPAWN_DONE",
        { host: new URL(base).host },
      );
      expect(output).toContain(`"orbId":"${childId}"`);
      expect(output).toContain(`"url":"${base}/orbs/${childId}"`);
      const session = fake;
      const calls = await waitFor(
        "first child inference uses selected canonical model",
        async () => {
          const calls: unknown = await fakeControl(session.sessionKey, "/requests");
          if (!Array.isArray(calls)) return null;
          const first = calls.find((call) => call.matchedRuleIndex === 0 && call.status === 200);
          if (!first) return null;
          expect(first.body.model).toBe("gpt-6-astra");
          expect(JSON.stringify(first.body)).toContain("America/Los_Angeles");
          return calls;
        },
      );
      save("first-requests.json", calls);
      await waitFor("child completes without a browser", async () => {
        const history = await api(base, "GET", `/api/v1/orbs/${childId}/history`);
        return JSON.stringify(history.body).includes("SPAWN_MODEL_COMPLETED") ? true : null;
      });
      const retry = await runTerminal(
        cp.baseUrl,
        callerId,
        `${command}; printf '\\123\\120\\101\\127\\116\\137\\122\\105\\124\\122\\131\\012'`,
        "SPAWN_RETRY",
        { host: new URL(base).host },
      );
      expect(retry).toContain(`"orbId":"${childId}"`);
      const inbox = await api(base, "POST", `/api/v1/orbs/${childId}/messages/poll`, {
        after: 0,
        tracked: [],
      });
      expect(inbox.body["items"]).toHaveLength(1);
      const requests: unknown = await fakeControl(session.sessionKey, "/requests");
      expect(
        Array.isArray(requests) &&
          requests.filter((call) => call.matchedRuleIndex === 0 && call.status === 200),
      ).toHaveLength(1);
      save("requests.json", requests);
      save("inbox.json", inbox.body);
      save("result.json", {
        agentBackend,
        projectId,
        callerId,
        childId,
        model: "openai-codex/gpt-6-astra",
        authenticatedInference: false,
      });
      expect((await api(base, "DELETE", `/api/v1/projects/${projectId}`)).status).toBe(202);
      const clock = cp.clock;
      if (clock === undefined) throw new Error("Missing owned control-plane clock");
      const advanced = await clock.advanceTo(
        Date.now() + DEFAULT_LIFECYCLE_CONSTANTS.deletionQuarantineMs,
      );
      expect(advanced.isOk()).toBe(true);
      await waitFor("project cleanup", async () =>
        (await api(base, "GET", `/api/v1/projects/${projectId}`)).status === 404 ? true : null,
      );
    } catch (cause) {
      writeFileSync(
        join(root, "failure.txt"),
        cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      );
      if (fake)
        save(
          "requests-failure.json",
          await fakeControl(fake.sessionKey, "/requests").catch(String),
        );
      throw cause;
    } finally {
      if (cp) writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
      const cleanup = await Promise.allSettled([
        cp?.stop(),
        ingress?.close(),
        git?.close(),
        fake ? deleteFakeSession(fake.sessionKey) : Promise.resolve(),
      ]);
      save("cleanup.json", cleanup);
      const failures = cleanup.filter((result) => result.status === "rejected");
      expect(failures).toHaveLength(0);
    }
  },
);

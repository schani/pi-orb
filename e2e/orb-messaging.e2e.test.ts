import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { type Browser, expect as check, chromium, type Page } from "@playwright/test";
import { build } from "vite";
import { expect, it } from "vitest";
import { openControlPlaneDatabase } from "../apps/control-plane/src/adapters/database.ts";
import {
  api,
  type ControlPlaneHandle,
  createFakeSession,
  deleteFakeSession,
  type FakeSession,
  FatalProbeError,
  type FixtureAgentBackend,
  fakeControl,
  readReplicatedHistorySnapshot,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import { ownedControlPlaneIngress } from "./testkit/owned-control-plane-ingress.ts";
import { ownedGitHttps } from "./testkit/owned-git-https.ts";

const stop = { type: "stop", status: "completed" } as const;
const user = (regex: string) => ({ userMessage: { regex } });
const result = (regex: string) => ({ toolResultContains: { regex } });
const reply = (match: Record<string, unknown>, content: string) => ({
  match,
  steps: [{ type: "text", content }, stop],
});
const call = (regex: string, name: string, args: object) => ({
  match: user(regex),
  steps: [{ type: "toolCall", name, arguments: args }, stop],
});
const summaryRule = () =>
  reply(user("^Write a single short desktop-notification sentence"), "Correspondence received.");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hostile =
  '<script>globalThis.__peerInjected=true</script>\n<img src=x onerror="globalThis.__peerInjected=true">\n**literal** & "quotes"\n' +
  "unbroken-".repeat(100);
type InboxRow = {
  id: string;
  status: string;
  system?: { kind: string; senderOrbId?: string };
  content: unknown;
};
type Receipt = {
  id: string;
  type: string;
  eventType?: string;
  sender?: { orbId: string };
  inboxMessageIds?: string[];
  content?: unknown;
};

/** Hold the real shared FIFO claim, not inbox/history responses, while inspecting pending UI. */
async function deliveryGate() {
  let release = () => {};
  let entered = 0;
  let gate = Promise.resolve();
  const server = createServer(async (_request, response) => {
    entered++;
    await gate;
    response.writeHead(200).end("released");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing delivery gate listener");
  return {
    url: `http://127.0.0.1:${address.port}/claim`,
    arm: () => {
      const before = entered;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => entered > before;
    },
    release: () => release(),
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it
  .runIf(process.env["PI_ORB_E2E_BACKEND"] === "process")
  .each(["central-durable", "host-pi"] as const)(
  "%s: real orb correspondence wakes stopped/sleeping peers and retains one trusted receipt on retry",
  async (agentBackend: FixtureAgentBackend) => {
    const runId = randomUUID();
    const evidenceRoot = join(import.meta.dirname, "../.context/cross-orb/messaging");
    mkdirSync(evidenceRoot, { recursive: true });
    const root = mkdtempSync(join(evidenceRoot, `${agentBackend}-`));
    const projectId = randomUUID(),
      senderId = randomUUID(),
      receiverId = randomUUID();
    const requestIds = [randomUUID(), randomUUID()];
    const bodies = [`STOPPED_PEER_BODY\n${hostile}`, `SLEEPING_PEER_BODY\n${hostile}`];
    let cp: ControlPlaneHandle | undefined;
    let git: Awaited<ReturnType<typeof ownedGitHttps>> | undefined;
    let ingress: Awaited<ReturnType<typeof ownedControlPlaneIngress>> | undefined;
    let fake: FakeSession | undefined;
    let names: FakeSession | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    let gate: Awaited<ReturnType<typeof deliveryGate>> | undefined;
    let failed = false;
    const cleanupErrors: unknown[] = [];
    let phase = "setup";
    const frames: { direction: string; frame: unknown }[] = [];
    const browserErrors: string[] = [];
    const save = (name: string, value: unknown) =>
      writeFileSync(join(root, name), JSON.stringify(value, null, 2));
    try {
      const repository = join(root, "source");
      mkdirSync(repository);
      writeFileSync(join(repository, "README.md"), "Messaging E2E fixture\n");
      for (const args of [
        ["init", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=E2E", "-c", "user.email=e2e@example.test", "commit", "-m", "fixture"],
      ])
        execFileSync("git", args, { cwd: repository, stdio: "ignore" });

      git = await ownedGitHttps(repository, root);
      const sendCode = (index: number) => {
        const body = bodies[index] ?? "";
        if (index === 0 && agentBackend === "central-durable")
          return `text(await tools.orb_send(${JSON.stringify({ orbId: receiverId, message: body })})); text('SEND_DONE_0');`;
        const command = `pi-orb send ${receiverId} ${quote(body)} --request-id ${requestIds[index]} && pi-orb send ${receiverId} ${quote(body)} --request-id ${requestIds[index]} && printf SEND_DONE_${index}`;
        return `text(await tools.bash(${JSON.stringify({ command })}));`;
      };
      fake = await createFakeSession(
        `orb-messaging-${runId}`,
        {
          auth: { accountId: `orb-messaging-${runId}`, device: { manualApprove: true } },
          model: {
            // Both orbs share the mock's forward-only cursor; release receiver work only after the sender settles.
            rules: [
              reply(user("^HUMAN_HANDSHAKE$"), "HUMAN_HANDSHAKE_ACK"),
              summaryRule(),
              ...[0, 1].flatMap((index) => [
                ...(index === 1
                  ? [
                      call("^SCHEDULE_PEER_SLEEP$", "bash", { command: "pi-orb sleep 30m" }),
                      reply(result("Sleep scheduled until"), "RECEIVER_SLEEP_ACK"),
                      summaryRule(),
                    ]
                  : []),
                call(`^SEND_PEER_${index}$`, "codemode", { code: sendCode(index) }),
                reply(result(`SEND_DONE_${index}`), `SENDER_ACK_${index}`),
                summaryRule(),
                reply(
                  user(index === 0 ? "STOPPED_PEER_BODY" : "SLEEPING_PEER_BODY"),
                  `RECEIVER_ACK_${index}`,
                ),
                summaryRule(),
              ]),
            ],
          },
        },
        agentBackend,
      );
      names = await createFakeSession(
        `orb-messaging-names-${runId}`,
        {
          model: {
            rules: [0, 1].map(() => reply({ default: true }, "Correspondence sender")),
          },
        },
        agentBackend,
      );
      const webRoot = join(import.meta.dirname, "../apps/web");
      await build({
        root: webRoot,
        configFile: join(webRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir: join(root, "web"), emptyOutDir: true },
      });
      // Finish cold schema initialization before the child-listen watchdog begins.
      const database = openControlPlaneDatabase({
        kind: "pglite",
        path: join(root, "db"),
      })._unsafeUnwrap();
      expect((await database.migrate()).isOk()).toBe(true);
      expect((await database.close()).isOk()).toBe(true);
      gate = await deliveryGate();
      ingress = await ownedControlPlaneIngress();
      const baseUrl = ingress.baseUrl;
      cp = await startControlPlane({
        port: 0,
        fake,
        nameFake: names,
        agentBackend,
        pglitePath: join(root, "db"),
        processStateDirectory: join(root, "hosts"),
        authDir: join(root, "auth"),
        hostingRoot: join(root, "hosting"),
        webDist: join(root, "web"),
        resourceRepository: repository,
        entry: join(import.meta.dirname, "testkit/orb-messaging-control-plane-entry.ts"),
        readinessHeaders: { host: new URL(baseUrl).host },
        extraEnv: {
          PI_ORB_E2E_HISTORY_INSPECTION: "1",
          PI_ORB_E2E_MESSAGE_CLAIM_GATE: gate.url,
          PI_ORB_E2E_MESSAGE_RECEIVER: receiverId,
          PI_ORB_APP_ORIGIN: baseUrl,
          PI_ORB_BROKER_URL: baseUrl,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${git.baseUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/e2e/orb-messaging",
          GIT_SSL_CAINFO: git.cert,
        },
      });
      ingress.connect(cp.baseUrl);
      const activeCp = { ...cp, baseUrl },
        activeFake = fake;
      const summaryCount = (wanted: number) =>
        waitFor(
          `${wanted} settled notifications`,
          async () => {
            const requests = await fakeControl(activeFake.sessionKey, "/requests");
            const summaries = (requests as unknown as { status: number; body?: unknown }[]).filter(
              (request) =>
                request.status === 200 &&
                JSON.stringify(request.body).includes(
                  "Write a single short desktop-notification sentence",
                ),
            );
            return summaries.length === wanted ? true : null;
          },
          { intervalMs: 250 },
        );
      const view = (id: string) => api(activeCp.baseUrl, "GET", `/api/v1/orbs/${id}`);
      const history = (id: string) => api(activeCp.baseUrl, "GET", `/api/v1/orbs/${id}/history`);
      const inbox = async (): Promise<InboxRow[]> => {
        const response = await api(baseUrl, "POST", `/api/v1/orbs/${receiverId}/messages/poll`, {
          after: 0,
          tracked: [],
        });
        expect(response.status).toBe(200);
        return response.body["items"] as InboxRow[];
      };
      const state = (id: string, wanted: string) =>
        waitFor(
          `${id} ${wanted}`,
          async () => {
            const response = await view(id);
            if (response.body["state"] === "failed")
              throw new FatalProbeError(JSON.stringify(response.body));
            return response.body["state"] === wanted ? response.body : null;
          },
          { timeoutMs: 300_000, intervalMs: 250 },
        );
      const human = async (id: string, text: string) => {
        const response = await api(baseUrl, "PUT", `/api/v1/orbs/${id}/messages/${randomUUID()}`, {
          content: [{ type: "text", text }],
        });
        expect(response.status).toBe(202);
      };
      expect(
        (
          await api(baseUrl, "POST", "/api/v1/projects", {
            id: projectId,
            name: "Correspondence E2E",
            repositoryUrl: "https://github.com/e2e/orb-messaging",
          })
        ).status,
      ).toBe(201);
      expect(
        (await api(baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, { id: senderId })).status,
      ).toBe(202);
      const code = await waitFor("sender device challenge", async () => {
        const action = (await view(senderId)).body["actionRequired"] as
          | { userCode?: string; verificationUri?: string }
          | undefined;
        return action?.userCode && action.verificationUri ? action.userCode : null;
      });
      await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: code });
      await state(senderId, "running");
      expect(
        (await api(baseUrl, "POST", `/api/v1/projects/${projectId}/orbs`, { id: receiverId }))
          .status,
      ).toBe(202);
      await state(receiverId, "running");

      browser = await chromium.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const activePage = page;
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("websocket", (socket) => {
        if (!socket.url().endsWith(`/orbs/${receiverId}/live`)) return;
        socket.on("framesent", ({ payload }) =>
          frames.push({ direction: "sent", frame: JSON.parse(String(payload)) }),
        );
        socket.on("framereceived", ({ payload }) =>
          frames.push({ direction: "received", frame: JSON.parse(String(payload)) }),
        );
      });
      phase = "handshake";
      await page.goto(`${baseUrl}/orbs/${receiverId}`);
      const composer = page.locator(".composer textarea");
      await check(composer).toBeEnabled({ timeout: 60_000 });
      await composer.fill("HUMAN_HANDSHAKE");
      await composer.press("Control+Enter");
      await check(page.getByText("HUMAN_HANDSHAKE_ACK", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await check(page.locator(".rec-you").filter({ hasText: "HUMAN_HANDSHAKE" })).toHaveCount(1);
      expect(
        frames.some(
          ({ direction, frame }) =>
            direction === "sent" && (frame as { type: string }).type === "client.hello",
        ),
      ).toBe(true);
      expect(JSON.stringify(frames)).not.toContain("stale_head");
      const humanColor = await page
        .locator(".rec-you")
        .filter({ hasText: "HUMAN_HANDSHAKE" })
        .evaluate(
          (element) => element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor,
        );

      expect(humanColor).toBe("rgb(0, 0, 0)");
      const assistantPaint = await page
        .locator(".rec-orb")
        .filter({ hasText: "HUMAN_HANDSHAKE_ACK" })
        .evaluate((element) => {
          const view = element.ownerDocument.defaultView;
          return {
            row: view?.getComputedStyle(element).backgroundColor,
            paper: view?.getComputedStyle(element.ownerDocument.body).backgroundColor,
          };
        });
      expect(assistantPaint).toEqual({ row: "rgba(0, 0, 0, 0)", paper: "rgb(255, 255, 255)" });
      await summaryCount(1);
      expect((await api(baseUrl, "POST", `/api/v1/orbs/${receiverId}/stop`)).status).toBe(202);
      await state(receiverId, "stopped");
      await page.setViewportSize({ width: 320, height: 800 });
      const messageIds: string[] = [];
      for (const index of [0, 1]) {
        phase = index === 0 ? "manual-stop-wake" : "sleep-wake-cli-retry";
        if (index === 1) {
          await human(receiverId, "SCHEDULE_PEER_SLEEP");
          await waitFor("sleep deadline retained", async () => {
            const response = await view(receiverId);
            return typeof response.body["sleepUntil"] === "string" ? true : null;
          });
          await state(receiverId, "stopped");
          await summaryCount(4);
        }
        const entered = gate.arm();
        await human(senderId, `SEND_PEER_${index}`);
        const row = await waitFor("trusted peer inbox acceptance", async () => {
          const rows = (await inbox()).filter(
            (item) =>
              item.system?.kind === "orb_message" &&
              JSON.stringify(item.content).includes(
                index === 0 ? "STOPPED_PEER_BODY" : "SLEEPING_PEER_BODY",
              ),
          );
          if (rows.length > 1) throw new FatalProbeError("duplicate peer acceptance");
          if (rows[0]) return rows[0];
          const source = await history(senderId);
          const records = source.body["records"] as {
            failure?: { message: string };
            content?: { type: string; text?: string; isError?: boolean }[];
          }[];
          const failure = records.findLast((record) => record.failure)?.failure;
          if (failure) throw new FatalProbeError(`sender provider failure: ${failure.message}`);
          if (records.some((record) => record.content?.some((block) => block.isError)))
            throw new FatalProbeError("sender tool rejected; inspect saved sender history/details");
          if (JSON.stringify(records).includes(`SENDER_ACK_${index}`))
            throw new FatalProbeError("sender completed without accepting the peer inbox record");
          return null;
        });
        messageIds.push(row.id);
        expect(row.system).toEqual({ kind: "orb_message", senderOrbId: senderId });
        await waitFor("receiver reached shared FIFO claim gate", async () =>
          entered() ? true : null,
        );
        expect((await view(receiverId)).body).not.toHaveProperty("sleepUntil");
        await page.reload();
        const pending = page.locator(".rec-peer.rec-q").filter({ hasText: bodies[index] ?? "" });
        await check(pending).toHaveCount(1, { timeout: 60_000 });
        await check(pending.locator(".peer-body")).toHaveText(bodies[index] ?? "");
        const senderLink = pending.getByRole("link");
        await check(senderLink).toHaveAttribute("href", `/orbs/${senderId}`);
        const senderName = await waitFor("sender name enrichment", async () => {
          const name = (await view(senderId)).body["name"];
          return typeof name === "string" && name !== "" ? name : null;
        });
        await check(senderLink).toHaveText(senderName);
        const peerColor = await pending.evaluate(
          (element) => element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor,
        );
        expect(peerColor).not.toBe(humanColor);
        expect(peerColor).toBe("rgb(242, 242, 242)");
        expect(await pending.locator("script, img, strong").count()).toBe(0);
        expect(
          await pending.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
          true,
        );
        expect(await page.evaluate(() => "__peerInjected" in globalThis)).toBe(false);
        await page.screenshot({ path: join(root, `pending-${index}-320.png`), fullPage: true });
        await waitFor("sender tool result retained", async () =>
          JSON.stringify((await history(senderId)).body).includes(`SENDER_ACK_${index}`)
            ? true
            : null,
        );
        await summaryCount(index === 0 ? 2 : 5);
        gate.release();
        await state(receiverId, "running");
        await check(page.getByText(`RECEIVER_ACK_${index}`, { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await check(page.locator(".rec-peer.rec-q")).toHaveCount(0, { timeout: 60_000 });
        const committed = page.locator(".rec-peer").filter({ hasText: bodies[index] ?? "" });
        await check(committed).toHaveCount(1);
        await check(committed.locator(".peer-body")).toHaveText(bodies[index] ?? "");
        await check(committed.getByRole("link")).toHaveText(senderName);
        const snapshot = await readReplicatedHistorySnapshot(cp, receiverId);
        const correlated = (snapshot.records as Receipt[]).filter((record) =>
          record.inboxMessageIds?.includes(row.id),
        );
        expect(correlated).toHaveLength(1);
        expect(correlated[0]).toMatchObject({
          type: "event",
          eventType: "orb.message",
          sender: { orbId: senderId },
          inboxMessageIds: [row.id],
          content: [{ type: "text", text: bodies[index] }],
        });
        expect((await inbox()).filter((item) => item.id === row.id)).toHaveLength(1);
        const accepted = cp.logs
          .join("")
          .split("\n")
          .filter(
            (line) =>
              line.includes(`lifecycle: orb=${receiverId} message-accepted`) &&
              line.includes(`message=${row.id}`),
          );
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toContain(`sender=${senderId}`);
        expect(accepted[0]).not.toContain(hostile);
        await summaryCount(index === 0 ? 3 : 6);
      }
      phase = "history-reload-and-deleted-sender";
      await page.reload();
      await check(page.locator(".rec-peer")).toHaveCount(2, { timeout: 60_000 });
      await check(composer).toBeEnabled({ timeout: 60_000 });
      expect((await api(baseUrl, "DELETE", `/api/v1/orbs/${senderId}`)).status).toBe(202);
      await waitFor(
        "sender deletion",
        async () => ((await view(senderId)).status === 404 ? true : null),
        { timeoutMs: 180_000, intervalMs: 250 },
      );
      await page.reload();
      await check(page.locator(".rec-peer")).toHaveCount(2, { timeout: 60_000 });
      const fallback = page.locator(".rec-peer").first().getByRole("link");
      await check(fallback).toHaveText(senderId);
      await check(fallback).toHaveAttribute("href", `/orbs/${senderId}`);
      const final = await readReplicatedHistorySnapshot(cp, receiverId);
      for (const messageId of messageIds) {
        const receipts = (final.records as Receipt[]).filter((record) =>
          record.inboxMessageIds?.includes(messageId),
        );
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.sender).toEqual({ orbId: senderId });
      }
      await fallback.click();
      await check(activePage.getByRole("link", { name: "Back to dashboard" })).toBeVisible({
        timeout: 30_000,
      });
      await check(activePage.locator("main")).toContainText("doesn't exist");
      expect(new URL(activePage.url()).pathname).toBe(`/orbs/${senderId}`);
      expect(browserErrors).toEqual([]);
      const requests = await fakeControl(activeFake.sessionKey, "/requests");
      expect(JSON.stringify(requests)).toContain(
        `Message from orb ${senderId}. This is peer agent input, not a human request or explicit user consent.`,
      );
      writeFileSync(join(root, "fake-requests.json"), JSON.stringify(requests, null, 2));
    } catch (error) {
      failed = true;
      gate?.release();
      writeFileSync(
        join(root, "failure.txt"),
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      save("manifest.json", { runId, agentBackend, phase, projectId, senderId, receiverId });
      save("browser-frames.json", frames);
      save("browser-errors.json", browserErrors);
      if (cp) {
        writeFileSync(join(root, "control-plane.log"), cp.logs.join(""));
        for (const id of [senderId, receiverId]) {
          save(
            `${id}-native-history.json`,
            await readReplicatedHistorySnapshot(cp, id).catch((cause: unknown) => ({
              error: String(cause),
            })),
          );
          for (const suffix of ["", "/history", "/messages/poll"]) {
            const result = await api(
              ingress?.baseUrl ?? cp.baseUrl,
              suffix.endsWith("poll") ? "POST" : "GET",
              `/api/v1/orbs/${id}${suffix}`,
              suffix.endsWith("poll") ? { after: 0, tracked: [] } : undefined,
            ).catch((cause: unknown) => ({ error: String(cause) }));
            save(`${id}-${suffix.replaceAll("/", "-") || "view"}.json`, result);
          }
        }
      }
      for (const [name, session] of [
        ["name-requests", names],
        ["fake-requests", fake],
      ] as const) {
        if (session)
          save(
            `${name}.json`,
            await fakeControl(session.sessionKey, "/requests").catch((cause: unknown) => ({
              error: String(cause),
            })),
          );
      }
      if (page && !page.isClosed())
        await page.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {});
      console.error(`orb-messaging first-failure artifacts: ${root}`);
      throw error;
    } finally {
      gate?.release();
      const cleanup = await Promise.allSettled([
        browser?.close(),
        cp?.stop(),
        ingress?.close(),
        gate?.close(),
        git?.close(),
        fake ? deleteFakeSession(fake.sessionKey) : Promise.resolve(),
        names ? deleteFakeSession(names.sessionKey) : Promise.resolve(),
      ]);
      if (!failed) rmSync(root, { recursive: true, force: true });
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      cleanupErrors.push(...errors);
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "messaging fixture cleanup failed");
  },
  720_000,
);

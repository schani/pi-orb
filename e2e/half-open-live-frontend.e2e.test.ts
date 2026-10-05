import { join } from "node:path";
import type { DisplayRecord } from "@pi-orb/protocol";
import { type Browser, expect as check, chromium, type Page, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { it } from "vitest";
import { listenFrontend } from "./frontend-listen.ts";

const orbId = "frontend-fixture-orb";
const at = "2026-10-05T00:00:00Z";
const userText = "Already applied question";
const assistantText = "Committed while the old socket was half-open";
const user = {
  id: "applied-user",
  parentId: null,
  timestamp: at,
  type: "message",
  role: "user",
  content: [{ type: "text", text: userText }],
} satisfies DisplayRecord;
const assistant = {
  ...user,
  id: "missed-assistant",
  parentId: user.id,
  role: "assistant",
  content: [{ type: "text", text: assistantText }],
} satisfies DisplayRecord;

it.each(["chromium", "webkit"] as const)(
  "%s: online replaces a half-open live socket and catches up an assistant suffix despite an empty inbox",
  async (engine) => {
    const root = join(import.meta.dirname, "../apps/web");
    let ownedVite: ViteDevServer | null = null;
    let ownedBrowser: Browser | null = null;
    let ownedPage: Page | null = null;
    let historyRequests = 0;
    let documentRequests = 0;
    const hellos: { socket: number; afterRecordId: string | null }[] = [];
    try {
      const vite = await createServer({
        root,
        configFile: join(root, "vite.config.ts"),
        mode: "frontend",
        server: { host: "127.0.0.1", port: 0 },
      });
      ownedVite = vite;
      await listenFrontend(vite);
      const address = vite.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const browser = await (engine === "chromium" ? chromium : webkit).launch();
      ownedBrowser = browser;
      const page = await browser.newPage();
      ownedPage = page;
      page.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests++;
      });
      await page.addInitScript(() => {
        const NativeWebSocket = globalThis.WebSocket;
        const sockets: HalfOpenSocket[] = [];
        class HalfOpenSocket {
          static OPEN = 1;
          readyState = 1;
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          closeCalls = 0;
          sent: object[] = [];
          constructor() {
            queueMicrotask(() => this.onopen?.(new Event("open")));
          }
          send(data: string) {
            if (this.sent.length === 0) sockets.push(this);
            this.sent.push(JSON.parse(data));
          }
          // Deliberately no close event or readyState transition: this models a
          // black-holed transport, not the normal close/backoff recovery path.
          close() {
            this.closeCalls++;
          }
          deliver(frame: object) {
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
          }
        }
        Reflect.set(globalThis, "__halfOpenSockets", sockets);
        Reflect.set(globalThis, "__halfOpenDocument", Math.random());
        globalThis.WebSocket = new Proxy(NativeWebSocket, {
          construct(target, args) {
            return String(args[0]).endsWith("/frontend-fixture-orb/live")
              ? new HalfOpenSocket()
              : Reflect.construct(target, args);
          },
        });
      });
      await page.route(`**/api/v1/orbs/${orbId}/messages/poll`, (route) =>
        route.fulfill({ json: { items: [], updates: [], cursor: 0 } }),
      );
      await page.route(`**/api/v1/orbs/${orbId}/history`, async (route) => {
        historyRequests++;
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), records: [], cursor: null, headId: null },
        });
      });
      const snapshot = () =>
        page.evaluate(() =>
          Reflect.get(globalThis, "__halfOpenSockets").map(
            (
              socket: {
                closeCalls: number;
                sent: { type: string; afterRecordId: string | null }[];
              },
              index: number,
            ) => ({
              socket: index,
              closeCalls: socket.closeCalls,
              hellos: socket.sent.filter((frame) => frame.type === "client.hello"),
            }),
          ),
        );
      const deliver = (socket: number, frames: object[]) =>
        page.evaluate(
          ({ socket, frames }) => {
            for (const frame of frames)
              Reflect.get(globalThis, "__halfOpenSockets")[socket].deliver(frame);
          },
          { socket, frames: frames.map((frame) => ({ v: 1, at, ...frame })) },
        );
      const welcome = (socket: number) => ({
        type: "server.welcome",
        connectionId: `connection-${socket}`,
        runtimeInstanceId: "same-runtime",
        orbId,
        sessionId: `fixture-session-${orbId}`,
        capabilities: [],
        limits: { maxIncomingFrameBytes: 1_000_000, maxPromptBytes: 1_000_000 },
      });
      const record = (value: DisplayRecord) => ({
        type: "history.record",
        record: value,
        headId: value.id,
        retiredBlockIds: [],
      });
      await page.goto(`http://127.0.0.1:${address.port}/orbs/${orbId}`);
      await check.poll(async () => (await snapshot())[0]?.hellos.length).toBe(1);
      await deliver(0, [
        welcome(0),
        { type: "sync.started", mode: "full", afterRecordId: null },
        record(user),
        { type: "sync.completed", headId: user.id },
      ]);
      const userRows = page.locator(".history .rec-you").filter({ hasText: userText });
      const assistantRows = page.locator(".history .rec-orb").filter({ hasText: assistantText });
      await check(userRows).toHaveCount(1);
      const initialHistoryRequests = historyRequests;
      const documentIdentity = await page.evaluate(() =>
        Reflect.get(globalThis, "__halfOpenDocument"),
      );
      const emptyPoll = page.waitForResponse((response) =>
        response.url().endsWith(`/${orbId}/messages/poll`),
      );
      await page.evaluate(() =>
        Reflect.get(globalThis, "dispatchEvent").call(globalThis, new Event("offline")),
      );
      // The server has committed assistant, but delivers no frames on the old
      // transport. Wait for the real application's next empty inbox response.
      check(await (await emptyPoll).json()).toEqual({ items: [], updates: [], cursor: 0 });
      await check(assistantRows).toHaveCount(0);
      await page.evaluate(() =>
        Reflect.get(globalThis, "dispatchEvent").call(globalThis, new Event("online")),
      );
      await check
        .poll(
          async () => {
            const sockets = await snapshot();
            hellos.splice(
              0,
              hellos.length,
              ...sockets.flatMap(
                (socket: { socket: number; hellos: { afterRecordId: string | null }[] }) =>
                  socket.hellos.map((hello) => ({
                    socket: socket.socket,
                    afterRecordId: hello.afterRecordId,
                  })),
              ),
            );
            return hellos;
          },
          {
            message:
              "A new socket must send hello from the applied user cursor; an empty inbox cannot repair the missing suffix",
          },
        )
        .toEqual([
          { socket: 0, afterRecordId: null },
          { socket: 1, afterRecordId: user.id },
        ]);
      check((await snapshot())[0].closeCalls).toBe(1);
      await deliver(1, [
        welcome(1),
        { type: "sync.started", mode: "after", afterRecordId: user.id },
        record(assistant),
        { type: "sync.completed", headId: assistant.id },
      ]);
      await check(assistantRows).toHaveCount(1);
      const staleText = "Only the retired transport sent this record";
      await deliver(0, [
        record({
          ...assistant,
          id: "stale-only-assistant",
          parentId: assistant.id,
          content: [{ type: "text", text: staleText }],
        }),
      ]);
      const barrierText = "Owned transport processing barrier";
      const barrier = {
        ...user,
        id: "owned-processing-barrier",
        parentId: assistant.id,
        content: [{ type: "text", text: barrierText }],
      } satisfies DisplayRecord;
      await deliver(1, [
        record(assistant),
        record(barrier),
        { type: "sync.completed", headId: barrier.id },
      ]);
      // Rendering the later owned record proves processing passed both the
      // stale-only frame and duplicate assistant; dedup cannot hide stale input.
      await check(page.locator(".history")).toContainText(barrierText);
      await check(page.locator(".history")).not.toContainText(staleText);
      await check(assistantRows).toHaveCount(1);
      await check(userRows).toHaveCount(1);
      check(historyRequests).toBe(initialHistoryRequests);
      check(documentRequests).toBe(1);
      check(await page.evaluate(() => Reflect.get(globalThis, "__halfOpenDocument"))).toBe(
        documentIdentity,
      );
    } finally {
      console.info(
        JSON.stringify({
          engine,
          hellos,
          historyRequests,
          documentRequests,
        }),
      );
      try {
        await ownedPage?.close();
      } finally {
        try {
          await ownedBrowser?.close();
        } finally {
          await ownedVite?.close();
        }
      }
    }
  },
);

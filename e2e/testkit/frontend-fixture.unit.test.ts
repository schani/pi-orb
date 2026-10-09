import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { expect, it } from "vitest";
import { observeFrontendBoot } from "./frontend-fixture.ts";

it("retains browser and WebSocket faults even after recent observations roll over, then removes listeners", async () => {
  const browser = Object.assign(new EventEmitter(), { isConnected: () => false });
  const frame = { url: () => "http://fixture.test/orbs/test" };
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: frame.url,
    mainFrame: () => frame,
    isClosed: () => false,
    evaluate: async () => ({ documentReadyState: "complete" }),
  });
  const socket = Object.assign(new EventEmitter(), {
    url: () => "ws://user:password@fixture.test/live?token=hidden#fragment",
  });
  const boot = observeFrontendBoot(page as unknown as Page);
  page.emit("websocket", socket);
  socket.emit("socketerror", "Network process crashed ws://fixture.test/live?token=hidden");
  socket.emit("close");
  page.emit("crash");
  browser.emit("disconnected");
  for (let index = 0; index < 20; index++) {
    page.emit("console", { type: () => "error", text: () => `later observation ${index}` });
  }
  await expect(boot.wait(Promise.reject(new Error("controlled reload failure")))).rejects.toThrow(
    '"browser":{"connected":false,"disconnections":1},"page":{"closed":false,"crashes":1},"websockets":{"opened":1,"closed":1,"errors":1,"pending":[]}',
  );
  expect(browser.eventNames()).toEqual([]);
  expect(page.eventNames()).toEqual([]);
  expect(socket.eventNames()).toEqual([]);
});

it("sanitizes active WebSocket URLs and fault observations", async () => {
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    url: () => "about:blank",
    isClosed: () => false,
    evaluate: async () => ({ documentReadyState: "complete" }),
  });
  const socket = Object.assign(new EventEmitter(), {
    url: () => "wss://user:password@fixture.test/live?token=hidden#fragment",
  });
  const boot = observeFrontendBoot(page as unknown as Page);
  page.emit("websocket", socket);
  socket.emit(
    "socketerror",
    "Network process crashed ws://user:password@fixture.test/live?token=hidden#fragment",
  );
  let diagnostic = "";
  try {
    await boot.wait(Promise.reject(new Error("controlled reload failure")));
  } catch (cause) {
    diagnostic = String(cause);
  }
  expect(diagnostic).toContain('"pending":["wss://fixture.test/live"]');
  expect(diagnostic).toContain("Network process crashed ws://fixture.test/live");
  expect(diagnostic).not.toMatch(/hidden|password|user:|fragment/);
  expect(socket.eventNames()).toEqual([]);
});

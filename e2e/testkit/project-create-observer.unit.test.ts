import { EventEmitter } from "node:events";
import type { BrowserContext } from "@playwright/test";
import { expect, it } from "vitest";
import { observeProjectCreates } from "./project-create-observer.ts";

it("observes project creation across pages without installing request interception", () => {
  const events = new EventEmitter();
  const context = events as unknown as Pick<BrowserContext, "on" | "off">;
  const posts: Record<string, unknown>[] = [];
  const stop = observeProjectCreates(context, posts);
  const emit = (method: string, path: string, body: Record<string, unknown>) =>
    events.emit("request", {
      method: () => method,
      url: () => `http://127.0.0.1:12345${path}`,
      postDataJSON: () => body,
    });

  emit("GET", "/api/v1/projects/scratchpad/orbs", {});
  emit("POST", "/api/v1/orbs/id/messages", { message: "ignored" });
  emit("POST", "/api/v1/projects/scratchpad/orbs/new", {});
  emit("POST", "/api/v1/projects/scratchpad/orbs", { id: "one", harness: "claude" });
  emit("POST", "/api/v1/projects/other/orbs", { id: "two", harness: "pi" });
  expect(posts).toEqual([
    { id: "one", harness: "claude" },
    { id: "two", harness: "pi" },
  ]);

  stop();
  expect(events.listenerCount("request")).toBe(0);
  emit("POST", "/api/v1/projects/scratchpad/orbs", { id: "after-stop" });
  expect(posts).toHaveLength(2);
});

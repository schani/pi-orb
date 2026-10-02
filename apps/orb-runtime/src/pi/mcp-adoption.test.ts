import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { recordMcpAdoption } from "./mcp-adoption.ts";

it("returns a typed failure when adoption persistence throws", () => {
  const manager = {
    getEntries: () => [],
    appendCustomEntry: () => {
      throw new Error("storage unavailable");
    },
  } as unknown as Pick<SessionManager, "getEntries" | "appendCustomEntry">;
  expect(
    recordMcpAdoption(manager, {
      revision: 3,
      servers: ["posthog"],
      secretRevision: 5,
    })._unsafeUnwrapErr(),
  ).toEqual({ type: "mcp_adoption_error", message: "Cannot record MCP configuration adoption" });
});

it("records catalog adoption only at edges, including removal to an empty catalog", () => {
  const manager = SessionManager.inMemory();
  const data = { revision: 3, servers: ["posthog"], secretRevision: 5 };
  expect(recordMcpAdoption(manager, data).isOk()).toBe(true);
  expect(recordMcpAdoption(manager, data).isOk()).toBe(true);
  expect(recordMcpAdoption(manager, { revision: 4, servers: [], secretRevision: 5 }).isOk()).toBe(
    true,
  );
  expect(recordMcpAdoption(manager, { revision: 4, servers: [], secretRevision: 5 }).isOk()).toBe(
    true,
  );
  expect(
    manager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-orb:mcp-config"),
  ).toHaveLength(2);
});

it("does not record an initial empty catalog", () => {
  const manager = SessionManager.inMemory();
  expect(recordMcpAdoption(manager, { revision: 0, servers: [], secretRevision: 0 }).isOk()).toBe(
    true,
  );
  expect(manager.getEntries()).toHaveLength(0);
});

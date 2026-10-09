import { NoSimulationTask } from "determined";
import { expect, it, vi } from "vitest";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { brokerProviderConfig } from "./provider.ts";

it("forwards native SDK refresh cancellation to the broker client", async () => {
  const task = new NoSimulationTask("provider-cancel", false);
  const client = new BrokerTokenClient({ requestToken: async () => ({ kind: "auth_required" }) });
  const fetch = vi.spyOn(client, "fetch");
  const provider = brokerProviderConfig(task, client, {});
  const controller = new AbortController();
  await expect(
    provider.oauth.refreshToken(
      { access: "fixture", expires: 0, refresh: "pi-orb-broker" },
      controller.signal,
    ),
  ).rejects.toThrow("auth_required");
  expect(fetch).toHaveBeenCalledWith(task, "expiring", controller.signal);
});

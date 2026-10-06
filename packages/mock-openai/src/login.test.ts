import { afterEach, describe, expect, it, vi } from "vitest";
import { mockOpenAiProviderConfig } from "./index.ts";

const config = {
  oauthBaseUrl: "https://mock.test/oai/session",
  inferenceBaseUrl: "https://mock.test/inference",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mock device challenge publication", () => {
  it.each([false, true])(
    "waits for the complete usercode response body (interrupted: %s)",
    async (interrupted) => {
      vi.useFakeTimers();
      let releaseBody!: (value: Record<string, unknown>) => void;
      const body = new Promise<Record<string, unknown>>((resolve) => {
        releaseBody = resolve;
      });
      const fetch = vi.fn().mockResolvedValue({ status: 200, json: () => body });
      vi.stubGlobal("fetch", fetch);
      const onDeviceCode = vi.fn();
      const controller = new AbortController();
      let settled = false;
      const interruption = new Error("Intentional probe interruption");
      const outcome = mockOpenAiProviderConfig(config)
        .oauth.login({
          onAuth: vi.fn(),
          onDeviceCode,
          signal: controller.signal,
        })
        .then(
          () => "completed",
          () => "rejected",
        )
        .finally(() => {
          expect(globalThis.fetch).toBe(fetch);
          settled = true;
        });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onDeviceCode).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(controller.signal.aborted).toBe(false);
        if (interrupted) throw interruption;
        releaseBody({ device_auth_id: "test-device", user_code: "CODE", interval: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(onDeviceCode).toHaveBeenCalledWith({
          userCode: "CODE",
          verificationUri: `${config.oauthBaseUrl}/codex/device`,
          intervalSeconds: 1,
        });
        controller.abort();
        expect(await outcome).toBe("rejected");
      } catch (error) {
        if (error !== interruption) throw error;
        expect(interrupted).toBe(true);
      } finally {
        releaseBody({ device_auth_id: "test-device", user_code: "CODE", interval: 1 });
        // Let login install its abort listener before aborting.
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await outcome;
        expect(settled).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it.each([
    { status: 503, body: { device_auth_id: "test-device", user_code: "CODE" } },
    { status: 200, body: { device_auth_id: "test-device", user_code: 123 } },
    { status: 200, body: { user_code: "CODE" } },
  ])("rejects without publishing for status/shape mismatch $status", async ({ status, body }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status, json: async () => body }));
    const onDeviceCode = vi.fn();
    await expect(
      mockOpenAiProviderConfig(config).oauth.login({ onAuth: vi.fn(), onDeviceCode }),
    ).rejects.toThrow(`mock device authorization failed (HTTP ${status})`);
    expect(onDeviceCode).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { runDst, waitUntil } from "../../testkit/sim.ts";
import { DeterministicTailscaleApiModel } from "../../testkit/tailscale-model.ts";
import { HttpTailscaleAuthKeyMinter } from "./client.ts";

describe("Tailscale incarnation fence (DST)", () => {
  it("a delayed older mint cannot revoke the newer host's enrollment authority", async () => {
    await runDst({ name: "tailscale-delayed-older-mint", iterations: 50 }, async (sim) => {
      const tailnet = new DeterministicTailscaleApiModel();
      let newerKey: string | null = null;
      const result = await sim.runTasks(
        [1, 2].map((incarnation) => ({
          name: `provisioner-i${incarnation}`,
          f: async (task) => {
            const minter = new HttpTailscaleAuthKeyMinter(
              {
                request: async (args) => {
                  await task.checkpoint(
                    "tailscale request",
                    incarnation,
                    args.method ?? "POST",
                    new URL(args.url).pathname,
                  );
                  if (incarnation === 1 && args.method === "GET") {
                    await waitUntil(task, "newer mint finished", () => newerKey !== null, {
                      intervalMs: 1,
                    });
                  }
                  return tailnet.request(args);
                },
              },
              { clientId: "model", clientSecret: "model" },
            );
            const minted = await minter.mintAuthKey(
              "orb",
              incarnation,
              new AbortController().signal,
            );
            expect(minted.isOk()).toBe(true);
            if (incarnation === 2 && minted.isOk()) newerKey = minted.value;
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const enrolled = tailnet.enroll("pi-orb-orb", newerKey ?? "");
      expect(enrolled.isOk(), JSON.stringify(tailnet.events)).toBe(true);
      if (enrolled.isErr()) return;
      // A later authorized replacement collects surplus older attempt keys,
      // without removing the retained device identity.
      const replacement = new HttpTailscaleAuthKeyMinter(tailnet, {
        clientId: "model",
        clientSecret: "model",
      });
      expect((await replacement.mintAuthKey("orb", 3, new AbortController().signal)).isOk()).toBe(
        true,
      );
      expect(tailnet.keyDescriptions()).toEqual(["pi-orb orb i3"]);
      expect(tailnet.resume(enrolled.value).isOk()).toBe(true);
    });
  });
});

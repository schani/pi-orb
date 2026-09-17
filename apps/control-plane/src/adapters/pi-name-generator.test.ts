import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import type { BrokerDeps } from "../domain/ports.ts";
import { PiOrbNameGenerator } from "./pi-name-generator.ts";

const completeLuna = vi.hoisted(() => vi.fn((_request: unknown) => okAsync("Bound owner name")));
vi.mock("@pi-orb/luna", () => ({ completeLuna }));

describe("PiOrbNameGenerator", () => {
  it("binds the owner broker and omits the owner UUID from the model prompt", async () => {
    const ownerUserId = "00000000-0000-4000-8000-00000000000a";
    const boundUsers: string[] = [];
    const brokerForUser = (userId: string): BrokerDeps => {
      boundUsers.push(userId);
      return {
        pointers: {
          readPointer: () =>
            okAsync({
              provider: "openai-codex",
              rowVersion: 1,
              generation: 4,
              secretVersion: "owner-version",
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
            }),
          casWritePointer: () => {
            throw new Error("unexpected pointer write");
          },
        },
        secrets: {
          readSecret: () =>
            okAsync({
              access: "owner-access",
              refresh: "owner-refresh",
              accountId: "owner-account",
              expiresAt: Date.now() + 3_600_000,
            }),
          writeSecret: () => {
            throw new Error("unexpected secret write");
          },
          listSecretVersions: () => okAsync([]),
          destroySecret: () => okAsync(undefined),
        },
        upstreams: {},
        constants: DEFAULT_BROKER_CONSTANTS,
      } as BrokerDeps;
    };
    const generator = new PiOrbNameGenerator(brokerForUser, "https://inference.example.test");

    const result = await generator.generate(
      new NoSimulationTask("name binding", false),
      {
        ownerUserId,
        projectName: "Compiler",
        repositoryUrl: "https://github.com/example/compiler",
        message: "Fix parser recovery",
        readme: "Project instructions",
      },
      { signal: new AbortController().signal },
    );

    expect(result._unsafeUnwrap()).toBe("Bound owner name");
    expect(boundUsers).toEqual([ownerUserId]);
    expect(completeLuna).toHaveBeenCalledOnce();
    const call = completeLuna.mock.calls[0]?.[0] as {
      prompt: string;
      auth: { apiKey: string; baseUrl: string };
    };
    expect(call.auth).toEqual({
      apiKey: "owner-access",
      baseUrl: "https://inference.example.test",
    });
    expect(call.prompt).toContain("Fix parser recovery");
    expect(call.prompt).not.toContain(ownerUserId);
  });
});

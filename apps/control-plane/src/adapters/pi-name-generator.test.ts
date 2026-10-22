import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BROKER_CONSTANTS } from "../domain/constants.ts";
import type { ModelCall } from "../domain/model-usage.ts";
import type { BrokerDeps } from "../domain/ports.ts";
import { PiOrbNameGenerator } from "./pi-name-generator.ts";

const completeLuna = vi.hoisted(() => vi.fn((_request: unknown) => okAsync("Bound owner name")));
vi.mock("@pi-orb/luna", () => ({ completeLuna }));
const response: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "gpt-6-luna",
  usage: {
    input: 40,
    output: 5,
    cacheRead: 8,
    cacheWrite: 0,
    totalTokens: 53,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
};
const recorded: ModelCall[] = [];
const ledger = { record: (_task: unknown, call: ModelCall) => void recorded.push(call) };
const ORB_ID = "00000000-0000-4000-8000-0000000000c1";

describe("PiOrbNameGenerator", () => {
  it.each(["absent", "store_failure"] as const)(
    "distinguishes %s credentials without inference",
    async (mode) => {
      completeLuna.mockClear();
      const generator = new PiOrbNameGenerator(
        () =>
          ({
            pointers: {
              casWritePointer: () => {
                throw new Error("unexpected pointer write");
              },
              readPointer: () =>
                mode === "absent"
                  ? okAsync(null)
                  : errAsync({
                      type: "store_error",
                      code: "unavailable",
                      message: "store unavailable",
                      retryable: true,
                    }),
            },
            secrets: {
              readSecret: () => {
                throw new Error("unexpected secret read");
              },
              writeSecret: () => {
                throw new Error("unexpected secret write");
              },
              listSecretVersions: () => okAsync([]),
              destroySecret: () => okAsync(undefined),
            },
            upstreams: {},
            constants: DEFAULT_BROKER_CONSTANTS,
          }) as BrokerDeps,
        ledger,
      );
      const result = await generator.generate(
        new NoSimulationTask("absent naming", false),
        {
          harness: "claude",
          ownerUserId: "owner",
          orbId: ORB_ID,
          projectName: "Project",
          repositoryUrl: "repo",
          message: "Work",
          readme: null,
        },
        { signal: new AbortController().signal },
      );
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject(
        mode === "absent" ? { code: "credential_absent" } : { message: "store unavailable" },
      );
      expect(completeLuna).not.toHaveBeenCalled();
    },
  );
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
    const generator = new PiOrbNameGenerator(
      brokerForUser,
      ledger,
      "https://inference.example.test",
    );

    const result = await generator.generate(
      new NoSimulationTask("name binding", false),
      {
        harness: "pi",
        ownerUserId,
        orbId: ORB_ID,
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
      onResponse: (response: AssistantMessage) => void;
    };
    expect(call.auth).toEqual({
      apiKey: "owner-access",
      baseUrl: "https://inference.example.test",
    });
    expect(call.prompt).toContain("Fix parser recovery");
    expect(call.prompt).not.toContain(ownerUserId);
    call.onResponse(response);
    expect(recorded).toEqual([
      {
        ownerUserId: ownerUserId,
        orbId: ORB_ID,
        use: "orb_name",
        provider: "openai-codex",
        model: "gpt-6-luna",
        outcome: "stop",
        input: 40,
        output: 5,
        cacheRead: 8,
        cacheWrite: 0,
        costUsd: 0,
      },
    ]);
  });
});

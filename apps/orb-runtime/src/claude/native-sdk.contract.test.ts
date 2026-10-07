import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HistoryRecord, projectDisplayRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { probeNestedContinuation } from "../../../../scripts/claude-sdk-contract/nested-continuation.mjs";
import {
  probeNativeSdk,
  probeNetworkGuard,
} from "../../../../scripts/claude-sdk-contract/probe.mjs";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { ClaudeHistory } from "./history.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../scripts/claude-sdk-contract/native-shapes.json", import.meta.url),
    "utf8",
  ),
);

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

for (const name of ["contract-leaf", "general-purpose"] as const) {
  for (const background of [false, true]) {
    for (const nestedBackground of [true, false, undefined]) {
      nativeIt(
        `production root-only policy denies project ${name} definition=${background} input=${nestedBackground}`,
        async () => {
          const composed = new ComposedClaudeFixture();
          try {
            expect((await composed.attach()).isOk()).toBe(true);
            expect(
              (
                await composed.agent.submitMessage(
                  [{ type: "text", text: "fixed qualification" }],
                  "native-policy",
                )
              ).isOk(),
            ).toBe(true);
            const callbacks = composed.query.options.hooks?.PreToolUse?.find(
              (entry) => entry.matcher === "Agent",
            )?.hooks;
            if (!callbacks) throw new Error("Production Agent hook missing.");
            // Tests-first: reject the old foreground-only policy before starting native descendants.
            const input = {
              hook_event_name: "PreToolUse" as const,
              session_id: composed.state.id,
              transcript_path: composed.nativePath,
              cwd: composed.dir,
              agent_id: "qualification-worker",
              tool_name: "Agent",
              tool_use_id: "qualification-dispatch",
              tool_input: {
                subagent_type: name,
                ...(nestedBackground === undefined ? {} : { run_in_background: nestedBackground }),
              },
            };
            const decision = await callbacks?.[0]?.(input, input.tool_use_id, {
              signal: new AbortController().signal,
            });
            expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
            const result = await probeNestedContinuation({
              productionPreToolUse: callbacks,
              projectAgent: { name, background },
              nestedBackground,
            });
            if (process.env.CLAUDE_ROOT_POLICY_ARTIFACT_DIR) {
              writeFileSync(
                join(
                  process.env.CLAUDE_ROOT_POLICY_ARTIFACT_DIR,
                  `rootpolicy-native-${name}-${background}-${nestedBackground ?? "absent"}.json`,
                ),
                `${JSON.stringify(result, null, 2)}\n`,
              );
            }
            expect(result.counts).toEqual({ root: 3, reviewer: 2, leaf: 0 });
            expect(result.rootAsyncAdmissions).toBe(1);
            expect(result.nestedDenialResults).toBe(3);
            expect(result.ordinaryToolResults).toBe(1);
            expect(result.descendantNativeFiles).toBe(0);
            expect(result.rootSawFinal).toBe(true);
            expect(result.rootSynthesisRecords).toBe(1);
            expect(result.reviewerSynthesisRecords).toBe(1);
            expect(result.nestedCompletionsAtRoot).toBe(0);
            expect(result.nestedCompletionsAtReviewer).toBe(0);
            expect(
              result.events.filter((event) => event.type === "reviewer-consumed-denials"),
            ).toEqual([expect.objectContaining({ count: 3 })]);
            const hooks = result.events.filter((event) => event.type === "pre-tool-use-hook");
            expect(hooks.filter((event) => event.agentId === null)).toEqual([
              expect.objectContaining({ decision: "unchanged", background: true }),
            ]);
            const nested = hooks.filter((event) => event.agentId !== null);
            expect(nested).toHaveLength(3);
            expect(new Set(nested.map((event) => event.agentId)).size).toBe(1);
            expect(nested.every((event) => event.decision === "deny")).toBe(true);
            expect(
              result.events.filter(
                (event) => event.type === "post-tool-use-hook" && event.agentId !== null,
              ),
            ).toEqual([]);
          } finally {
            composed.query.exit();
            composed.query.endOutput();
            composed.dispose();
          }
        },
        40_000,
      );
    }
  }
}

nativeIt(
  "production policy preserves parallel root fanout",
  async () => {
    const composed = new ComposedClaudeFixture();
    try {
      expect((await composed.attach()).isOk()).toBe(true);
      expect(
        (
          await composed.agent.submitMessage(
            [{ type: "text", text: "fixed qualification" }],
            "native-fanout",
          )
        ).isOk(),
      ).toBe(true);
      const callbacks = composed.query.options.hooks?.PreToolUse?.[0]?.hooks;
      if (!callbacks) throw new Error("Production Agent hook missing.");
      const result = await probeNestedContinuation({
        productionPreToolUse: callbacks,
        projectAgent: { name: "general-purpose", background: true },
        nestedBackground: undefined,
        rootFanout: true,
      });
      if (process.env.CLAUDE_ROOT_POLICY_ARTIFACT_DIR) {
        writeFileSync(
          join(process.env.CLAUDE_ROOT_POLICY_ARTIFACT_DIR, "rootpolicy-native-fanout.json"),
          `${JSON.stringify(result, null, 2)}\n`,
        );
      }
      expect(result.rootAsyncAdmissions).toBe(2);
      expect(result.peerRequests).toBe(1);
      expect(
        result.events.filter((event) => event.type === "root-fanout-provider-barrier"),
      ).toEqual([expect.objectContaining({ count: 2 })]);
      expect(
        result.events.filter(
          (event) => event.type === "pre-tool-use-hook" && event.agentId === null,
        ),
      ).toHaveLength(2);
      expect(result.counts.leaf).toBe(0);
      expect(result.descendantNativeFiles).toBe(0);
      expect(result.nestedDenialResults).toBe(3);
      expect(result.rootSawFinal).toBe(true);
    } finally {
      composed.query.exit();
      composed.query.endOutput();
      composed.dispose();
    }
  },
  40_000,
);

nativeIt(
  "routes stopped reviewers' nested completions to root with streaming input still open",
  async () => {
    const result = await probeNestedContinuation({ closePolicy: "after-final-result" });
    expect(result.nestedCompletionsAtRoot).toBe(3);
    expect(result.nestedCompletionsAtReviewer).toBe(0);
    expect(result.counts.reviewer).toBe(2);
    expect(result.reviewerResumed).toBe(false);
    const release = result.events.findIndex((event) => event.type === "release-nested-responses");
    const close = result.events.findIndex((event) => event.type === "input-closed");
    expect(release).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(release);
  },
  40_000,
);

nativeIt(
  "keeps delivering nested completions after input closes at the first native result",
  async () => {
    const result = await probeNestedContinuation({ closePolicy: "first-result" });
    expect(result.nestedCompletionsAtRoot).toBe(3);
    expect(result.reviewerResumed).toBe(false);
    const release = result.events.findIndex((event) => event.type === "release-nested-responses");
    const close = result.events.findIndex((event) => event.type === "input-closed");
    expect(close).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(close);
  },
  40_000,
);

nativeIt(
  "can resume the stopped reviewer through a model-issued native SendMessage",
  async () => {
    const result = await probeNestedContinuation({ resumeReviewer: true });
    expect(result.nestedCompletionsAtRoot).toBe(3);
    expect(result.reviewerResumed).toBe(true);
    expect(result.rootSawFinal).toBe(true);
  },
  40_000,
);

for (const releaseOrder of ["forward", "reverse"] as const) {
  nativeIt(
    `historical SDK mechanism: honors Agent updatedInput under permission bypass (${releaseOrder})`,
    async () => {
      const result = await probeNestedContinuation({ hookNestedForeground: true, releaseOrder });
      expect(result.rootSawFinal).toBe(true);
      expect(result.counts.reviewer).toBe(2);
      expect(result.nestedCompletionsAtRoot).toBe(0);
      expect(result.rootAsyncAdmissions).toBe(1);
      expect(result.nestedForegroundResults).toBe(3);
      expect(result.rootSynthesisRecords).toBe(1);
      expect(result.reviewerSynthesisRecords).toBe(1);
      expect(
        result.events.filter((event) => event.type === "reviewer-consumed-foreground-results"),
      ).toEqual([expect.objectContaining({ count: 3 })]);
      const rootContinuation = result.events.findIndex(
        (event) => event.type === "provider-request" && event.lane === "root" && event.turn === 2,
      );
      const firstChildRelease = result.events.findIndex(
        (event) => event.type === "release-nested-response",
      );
      expect(rootContinuation).toBeGreaterThan(0);
      expect(firstChildRelease).toBeGreaterThan(rootContinuation);
      const hooks = result.events.filter((event) => event.type === "pre-tool-use-hook");
      expect(hooks.filter((event) => event.agentId === null)).toEqual([
        expect.objectContaining({ toolName: "Agent", decision: "unchanged", background: true }),
      ]);
      const nested = hooks.filter((event) => event.agentId !== null);
      expect(nested).toHaveLength(3);
      expect(new Set(nested.map((event) => event.agentId)).size).toBe(1);
      const executedNested = result.events.filter(
        (event) => event.type === "post-tool-use-hook" && event.agentId !== null,
      );
      expect(executedNested).toHaveLength(3);
      expect(executedNested.every((event) => event.background === false)).toBe(true);
      expect(
        nested.every((event) => event.decision === "foreground" && event.background === true),
      ).toBe(true);
      expect(
        result.events
          .filter((event) => event.type === "release-nested-response")
          .map((event) => event.index),
      ).toEqual(releaseOrder === "forward" ? [0, 1, 2] : [2, 1, 0]);
    },
    40_000,
  );
}

for (const name of ["contract-leaf", "general-purpose"] as const) {
  for (const background of [false, true]) {
    nativeIt(
      `historical SDK mechanism: project ${name} background=${background} overrides foreground input`,
      async () => {
        const result = await probeNestedContinuation({
          hookNestedForeground: true,
          projectAgent: { name, background },
        });
        expect(result.counts.leaf).toBe(3);
        expect(result.nestedForegroundResults).toBe(background ? 0 : 3);
        expect(result.nestedCompletionsAtRoot).toBe(background ? 3 : 0);
        expect(result.rootSawFinal).toBe(!background);
        expect(result.rootSynthesisRecords).toBe(background ? 0 : 1);
        expect(result.reviewerSynthesisRecords).toBe(background ? 0 : 1);
        expect(result.rootAsyncAdmissions).toBe(1);
        const pre = result.events.filter(
          (event) => event.type === "pre-tool-use-hook" && event.agentId !== null,
        );
        expect(pre).toHaveLength(3);
        expect(
          pre.every((event) => event.decision === "foreground" && event.background === true),
        ).toBe(true);
        const post = result.events.filter(
          (event) => event.type === "post-tool-use-hook" && event.agentId !== null,
        );
        expect(post).toHaveLength(3);
        expect(post.every((event) => event.background === false)).toBe(true);
        const release = result.events.findIndex(
          (event) => event.type === "release-nested-responses",
        );
        const parked = result.events.findIndex(
          (event) => event.type === "subagent-stop-hook" && event.reviewerStopped === true,
        );
        if (background) {
          expect(parked).toBeGreaterThan(0);
          expect(release).toBeGreaterThan(parked);
          expect(result.counts.reviewer).toBe(2);
        }
      },
      40_000,
    );
  }
}

nativeIt(
  "restricts native network access to the owned loopback TCP port",
  async () => {
    expect(await probeNetworkGuard()).toEqual({
      localAllowed: true,
      externalDenied: true,
      otherPortDenied: true,
      udpDenied: true,
    });
  },
  10_000,
);

nativeIt(
  "preserves submitted and streamed identities in the native root transcript",
  async () => {
    const result = await probeNativeSdk();
    expect(result.account).toEqual({
      tokenSource: "none",
      apiKeySource: "ANTHROPIC_API_KEY",
      apiProvider: "firstParty",
    });
    expect(result.requestCount).toBe(2);
    expect(result.userUuid).toBe(result.submittedUuid);
    expect(result.assistantUuids).toEqual(result.streamAssistantUuids);
    expect(result.toolResultUuids).toEqual(result.streamToolResultUuids);
    expect(result.toolOutput).toBe("native-contract-fixed-output");
    expect(result.rootFile).toBe(`${result.sessionId}.jsonl`);
    expect(result.rootHasTrailingNewline).toBe(true);
    expect(result.projectKeyMatchesCwd).toBe(true);
    expect(result.sdkVersion).toBe(fixture.sdkVersion);
    expect(result.cliVersion).toBe(fixture.cliVersion);
    expect(result.childFiles).toEqual([]);
    expect(result.conversationShapes).toEqual(fixture.conversationShapes);
    expect(result.effectiveModel).toBe("claude-sonnet-5-5");
    expect(result.requestSettings).toEqual([
      { model: "claude-sonnet-5-5", effort: "low" },
      { model: "claude-sonnet-5-5", effort: "low" },
    ]);
    expect(result.nativeEfforts).toEqual(["low", "low"]);
    expect(result.result).toEqual({ subtype: "success", isError: false });
  },
  30_000,
);

nativeIt(
  "keeps native child conversation records out of the root transcript",
  async () => {
    const result = await probeNativeSdk({ withSubagent: true });
    expect(result.result).toEqual({ subtype: "success", isError: false });
    expect(result.childFiles).toHaveLength(1);
    expect(result.requestCount).toBe(4);
    expect(result.childNativeAssistantUuids).toHaveLength(2);
    // Native SDK forwards the child's tool-call message, not its final hand-back.
    expect(result.childAssistantUuids).toEqual([result.childNativeAssistantUuids[0]]);
    expect(result.rootContainsChildAssistant).toBe(false);
  },
  30_000,
);

nativeIt(
  "appends native compaction without rewriting the durable pre-compaction prefix",
  async () => {
    let commandEcho: Record<string, unknown> | undefined;
    const result = await probeNativeSdk({
      withCompact: true,
      compactInstructions: "Preserve the native-contract-custom-instructions marker.",
      onRoot: ({ home, sessionId, rootPath, compactUuid }) => {
        commandEcho = readFileSync(rootPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .find(
            (record) =>
              record.type === "user" &&
              JSON.stringify(record.message?.content).includes("/compact"),
          );
        expect(commandEcho?.promptId).not.toBe(compactUuid);
        expect(commandEcho?.uuid).toBe(compactUuid);
        const history = new ClaudeHistory(
          join(home, "compact-projection"),
          sessionId,
          "2026-10-06T00:00:00Z",
        );
        history
          .correlate(compactUuid, { messageIds: [], operationId: "manual", compaction: true })
          ._unsafeUnwrap();
        const records = history.scan(rootPath)._unsafeUnwrap();
        expect(records.find((record) => record.id === commandEcho?.uuid)).toMatchObject({
          type: "event",
          eventType: "claude.compact_command",
        });
        expect(records.filter((record) => record.type === "compaction")).toHaveLength(1);
        const display = records.map(projectDisplayRecord);
        expect(
          display.filter((record) => record.type === "message" && record.role === "user"),
        ).toHaveLength(1);
        expect(JSON.stringify(display)).not.toContain("local-command-");
        expect(
          new ClaudeHistory(join(home, "compact-projection"), sessionId, "2026-10-06T00:00:00Z")
            .scan(rootPath)
            ._unsafeUnwrap(),
        ).toEqual(records);
        expect(JSON.stringify(records)).not.toContain("native-contract-custom-instructions");
      },
    });
    expect(commandEcho).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: expect.stringMatching(
          /^<command-name>\/compact<\/command-name>\s*<command-message>compact<\/command-message>\s*<command-args>Preserve the native-contract-custom-instructions marker\.<\/command-args>$/,
        ),
      },
    });
    expect(commandEcho).not.toHaveProperty("isMeta");
    expect(result.compaction.customInstructionsReachedProvider).toBe(true);
    expect(result.compaction.providerRequests).toBe(1);
    expect(result.compaction.ordinaryAssistantContinuation).toBe(false);
    expect(result.compaction.boundaryContentIsSummary).toBe(false);
    expect(result.compaction.statuses).toContainEqual({
      status: null,
      compactResult: "success",
      hasCompactError: false,
    });
    expect(result.compaction.summary).toMatchObject({
      type: "user",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      hasContent: true,
    });
    // Native command echoes are private transcript entries, not product user input.
    expect(result.compaction.commandEchoCount).toBe(1);
    expect(result.compaction).toMatchObject({
      prefixPreserved: true,
      hasBoundary: true,
      hasSummary: true,
    });
    expect(result.compaction.metadataKeys).toEqual(fixture.compaction.metadataKeys);
    expect(result.compaction.boundaryKeys).toEqual(fixture.compaction.boundaryKeys);
    expect(result.compaction.summaryKeys).toEqual(fixture.compaction.summaryKeys);
    expect(result.rootHasTrailingNewline).toBe(true);
  },
  30_000,
);

for (const cancelAt of [
  "initialization",
  "before-enqueue",
  "before-dispatch",
  "in-progress",
  "queued",
] as const) {
  nativeIt(
    `qualifies public interrupt of native compaction at ${cancelAt}`,
    async () => {
      const result = await probeNativeSdk({ withCompact: true, cancelAt });
      expect(result.cancellation.requested).toBe(true);
      expect(result.cancellation.accepted).toBe(true);
      expect(result.cancellation.drained).toBe(true);
      if (cancelAt === "queued") {
        expect(result.cancellation.receipt?.still_queued).toContain(result.cancellation.queuedUuid);
      }
      // Public interrupt leaves queued slash commands runnable; native may compact
      // before the caller observes the result and closes the process.
      expect(result.compaction.hasSummary).toBe(cancelAt === "queued");
      expect(result.compaction.providerRequests).toBe(
        cancelAt === "in-progress" || cancelAt === "queued" ? 1 : 0,
      );
      expect(result.compaction.ordinaryAssistantContinuation).toBe(false);
    },
    30_000,
  );
}

nativeIt(
  "projects native UUID receipts into durable inbox provenance",
  async () => {
    let projected: readonly HistoryRecord[] = [];
    const result = await probeNativeSdk({
      onRoot: ({ home, rootPath, sessionId, submittedUuid }) => {
        const history = new ClaudeHistory(
          join(home, "projection"),
          sessionId,
          "2026-10-04T00:00:00Z",
        );
        history
          .correlate(submittedUuid, {
            messageIds: ["native-contract-inbox"],
            operationId: "native-contract-operation",
          })
          ._unsafeUnwrap();
        projected = history.scan(rootPath)._unsafeUnwrap();
      },
    });
    expect(projected.find((record) => record.id === result.submittedUuid)).toMatchObject({
      type: "message",
      role: "user",
      inboxMessageIds: ["native-contract-inbox"],
    });
    expect(
      projected
        .filter((record) => record.type === "message" && record.role === "assistant")
        .map((record) => record.id),
    ).toEqual(result.streamAssistantUuids);
  },
  30_000,
);

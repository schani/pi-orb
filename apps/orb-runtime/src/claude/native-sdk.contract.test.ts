import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import {
  probeNativeSdk,
  probeNetworkGuard,
} from "../../../../scripts/claude-sdk-contract/probe.mjs";
import { ClaudeHistory } from "./history.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../scripts/claude-sdk-contract/native-shapes.json", import.meta.url),
    "utf8",
  ),
);

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

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
    const result = await probeNativeSdk({ withCompact: true });
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

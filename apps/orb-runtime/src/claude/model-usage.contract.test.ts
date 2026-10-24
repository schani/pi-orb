import { expect, it } from "vitest";
import { probeNativeSdk } from "../../../../scripts/claude-sdk-contract/probe.mjs";
import {
  type ClaudeModelCall,
  startModelUsageReceiver,
  telemetryEnvironment,
} from "./model-usage.ts";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

nativeIt(
  "real Claude Code exports one call per API request, tagged root, subagent and compaction",
  async () => {
    const calls: ClaudeModelCall[] = [];
    let exported = () => undefined as void;
    const receiver = (
      await startModelUsageReceiver((call) => {
        calls.push(call);
        exported();
      })
    )._unsafeUnwrap();
    try {
      const result = await probeNativeSdk({
        withSubagent: true,
        withCompact: true,
        env: telemetryEnvironment(receiver),
        allowPorts: [Number(new URL(receiver.endpoint).port)],
      });
      // Claude Code batches exports; wait for exactly the calls the fake API served.
      while (calls.length < result.requestCount)
        await new Promise<void>((resolve) => {
          exported = resolve;
        });
      expect(calls).toHaveLength(result.requestCount);
      for (const call of calls) {
        expect(call).toMatchObject({ input: 16, output: 8, cacheRead: 23, cacheWrite: 41 });
      }
      expect(
        calls.every((call) => call.outcome === "ok" && call.model === "claude-sonnet-5-5"),
      ).toBe(true);
      expect(new Set(calls.map((call) => call.querySource))).toEqual(
        new Set(["sdk", "agent:custom", "compact"]),
      );
    } finally {
      await receiver.close();
    }
  },
  60_000,
);

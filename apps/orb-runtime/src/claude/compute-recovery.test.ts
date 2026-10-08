import type { HistoryRecord, JsonObject } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  claudeRecoveryEpisode,
  qualifyClaudeRestart,
  reconcileClaudeComputeOwnership,
} from "./restore.ts";

describe("verified Claude compute recovery", () => {
  const state = { id: "session", deliveries: {}, ownedChildren: { child: "operation" } };
  it("keys the budget by retained ownership, not lifetime or insertion order", () => {
    expect(claudeRecoveryEpisode(state)).toMatch(/^[a-f0-9]{64}$/);
    expect(claudeRecoveryEpisode({ ...state, guardLifetime: "new" })).toBe(
      claudeRecoveryEpisode(state),
    );
    expect(
      claudeRecoveryEpisode({ ...state, ownedChildren: { child: "private description" } }),
    ).toBe(claudeRecoveryEpisode(state));
    expect(
      claudeRecoveryEpisode({
        ...state,
        deliveries: { inbox: { uuid: "native", operationId: "other", submitted: true } },
      }),
    ).not.toBe(claudeRecoveryEpisode(state));
    expect(claudeRecoveryEpisode({ ...state, id: "other" })).not.toBe(claudeRecoveryEpisode(state));
  });
  it("incarnation or unsandboxed supervisor changes do not prove physical lifetime loss", () => {
    for (const [before, after] of [
      ["claude:2:kernel:100", "claude:3:kernel:100"],
      ["claude:2:supervisor-a", "claude:3:supervisor-b"],
    ]) {
      expect(qualifyClaudeRestart({ ...state, guardLifetime: before! }, [], after!).isErr()).toBe(
        true,
      );
    }
  });
  it("requires exact episode and replacement incarnation for missing lifetime", () => {
    const proof = {
      episode: claudeRecoveryEpisode(state),
      disposedIncarnation: 2,
      replacementIncarnation: 3,
    };
    expect(qualifyClaudeRestart(state, [], "new").isErr()).toBe(true);
    expect(qualifyClaudeRestart(state, [], "new", { proof, incarnation: 3 }).isOk()).toBe(true);
    expect(qualifyClaudeRestart(state, [], "new", { proof, incarnation: 4 }).isErr()).toBe(true);
    expect(
      qualifyClaudeRestart(state, [], "new", {
        proof: { ...proof, episode: "0".repeat(64) },
        incarnation: 3,
      }).isErr(),
    ).toBe(true);
    expect(
      qualifyClaudeRestart(state, [], "new", {
        proof: { ...proof, disposedIncarnation: 3 },
        incarnation: 3,
      }).isErr(),
    ).toBe(true);
  });
  it("publishes before ownership removal and reconciles publication/save crash cuts once", () => {
    const owned = { ...state, pendingHandoffs: { task: "handoff" }, handoffTerminals: {} };
    const proof = {
      episode: claudeRecoveryEpisode(owned),
      disposedIncarnation: 0,
      replacementIncarnation: 1,
    };
    const recovery = { proof, incarnation: 1 };
    const records: HistoryRecord[] = [];
    let publications = 0;
    const publish = (id: string, overflow: JsonObject) => {
      expect(owned.ownedChildren.child).toBe("operation");
      publications++;
      records.push({
        id,
        parentId: null,
        timestamp: "2026-10-06T00:00:00Z",
        type: "event",
        eventType: "claude.children_interrupted",
        overflow,
      });
      return ok(undefined);
    };
    expect(
      reconcileClaudeComputeOwnership(owned, records, "new", publish, () => ok(undefined)).isErr(),
    ).toBe(true);
    expect(publications).toBe(0);
    expect(
      reconcileClaudeComputeOwnership(
        owned,
        records,
        "new",
        publish,
        () => err({ message: "crash" }),
        recovery,
      ).isErr(),
    ).toBe(true);
    expect(owned.ownedChildren).toEqual(state.ownedChildren);
    expect(owned.pendingHandoffs).toEqual({ task: "handoff" });
    expect(
      reconcileClaudeComputeOwnership(
        owned,
        records,
        "new",
        publish,
        () => ok(undefined),
        recovery,
      ).isOk(),
    ).toBe(true);
    expect(owned.ownedChildren).toEqual({});
    expect(owned.pendingHandoffs).toEqual({});
    expect(publications).toBe(1);
  });
  it("never uses proof to replay an unreceipted submitted delivery", () => {
    const uncertain = {
      ...state,
      deliveries: { inbox: { uuid: "native", operationId: "op", submitted: true } },
    };
    const proof = {
      episode: claudeRecoveryEpisode(uncertain),
      disposedIncarnation: 2,
      replacementIncarnation: 3,
    };
    const result = qualifyClaudeRestart(uncertain, [], "new", { proof, incarnation: 3 });
    expect(result.isErr() && result.error.code).toBe("claude_delivery_uncertain");
  });
});

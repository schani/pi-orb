import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { readExecutionIdentity } from "../pi/execution-identity.ts";
import {
  claudeRecoveryEpisode,
  parseClaudePhysicalLifetime,
  qualifyClaudeRestart,
  reconcileClaudeComputeOwnership,
} from "./restore.ts";

const boot = "01234567-89ab-4cde-8fab-0123456789ab";
const otherBoot = "11234567-89ab-4cde-8fab-0123456789ab";
const known = `claude:7:${boot}:100`;
const unknown = [
  undefined,
  "",
  "unknown",
  "old",
  "new",
  `${boot}:100`,
  "claude:7:native",
  `claude:7:${"a".repeat(64)}`,
  `claude:8:${"b".repeat(64)}`,
  `claude:7:${boot}`,
  `claude:7:${boot}:`,
  `claude:7:${boot}:-1`,
  `claude:7:${boot}:01`,
  `claude:7:${boot}:1.0`,
  `claude:7:${boot}:1e2`,
  `claude:7:${boot}:100:supervisor`,
  `claude:7:${boot}:100\n`,
  `claude:7:${boot}:100 `,
  `claude:7:${"a".repeat(36)}:100`,
  "claude:7:00000000-0000-0000-0000-00000000000z:100",
  `claude:7:${boot.toUpperCase()}:100`,
  `claude:x:${boot}:100`,
  `claude:-1:${boot}:100`,
  `claude:01:${boot}:100`,
] as const;
const owned = () => ({
  id: "session",
  deliveries: {},
  ownedChildren: { child: "owner" },
  ownedTasks: { task: "owner" },
  ownedBackgroundTasks: { background: "owner" },
  pendingHandoffs: { handoff: "owner" },
});

describe("Claude physical lifetime proof", () => {
  it("retained guard 'unknown' cannot authorize clearing against a production physical identity", () => {
    const state = { ...owned(), guardLifetime: "unknown" };
    const before = structuredClone(state);
    let publications = 0;
    const qualified = qualifyClaudeRestart(state, [], known);
    const released = reconcileClaudeComputeOwnership(
      state,
      [],
      known,
      () => {
        publications++;
        return ok(undefined);
      },
      () => ok(undefined),
    );
    expect({
      qualified: qualified.isErr(),
      released: released.isErr(),
      publications,
      state,
    }).toEqual({ qualified: true, released: true, publications: 0, state: before });
  });
  it("parses exactly the production wrapper around the procfs reader's identity, including zero", () => {
    for (const start of ["0", "100", "18446744073709551615"]) {
      const statFields = Array<string>(20).fill("0");
      statFields[19] = start;
      const identity = readExecutionIdentity({ PI_ORB_CONTAINER: "1" }, (path) =>
        ok(
          path.endsWith("boot_id") ? boot : `1 (PID1 with parentheses ()) ${statFields.join(" ")}`,
        ),
      )._unsafeUnwrap();
      expect(parseClaudePhysicalLifetime(`claude:7:${identity}`)).toEqual({
        kernelBootId: boot,
        pid1StartTime: start,
      });
    }
    for (const value of unknown) expect(parseClaudePhysicalLifetime(value)).toBeNull();
  });

  it("only two valid differing kernel/PID1 identities prove physical death", () => {
    for (const current of [`claude:8:${boot}:101`, `claude:8:${otherBoot}:100`]) {
      expect(
        qualifyClaudeRestart({ ...owned(), guardLifetime: known }, [], current)._unsafeUnwrap()
          .orphanedChildren,
      ).toEqual(["background", "child", "handoff", "task"]);
    }
    for (const current of [known, `claude:8:${boot}:100`])
      expect(
        qualifyClaudeRestart({ ...owned(), guardLifetime: known }, [], current)._unsafeUnwrapErr()
          .code,
      ).toBe("claude_child_recovery_required");
    expect(
      qualifyClaudeRestart(
        { ...owned(), guardLifetime: `claude:7:${boot}:0` },
        [],
        `claude:8:${boot}:1`,
      ).isOk(),
    ).toBe(true);
  });

  it("never qualifies an unknown old or current identity, including mixed formats", () => {
    for (const before of [...unknown, known]) {
      for (const current of [...unknown.filter((value) => value !== undefined), known]) {
        if (before === known && current === known) continue;
        const state = { ...owned(), ...(before === undefined ? {} : { guardLifetime: before }) };
        expect(
          qualifyClaudeRestart(state, [], current).isErr(),
          JSON.stringify([before, current]),
        ).toBe(true);
        let published = false;
        let saved = false;
        expect(
          reconcileClaudeComputeOwnership(
            state,
            [],
            current,
            () => {
              published = true;
              return ok(undefined);
            },
            () => {
              saved = true;
              return ok(undefined);
            },
          ).isErr(),
        ).toBe(true);
        expect(published).toBe(false);
        expect(saved).toBe(false);
        expect(state).toEqual({
          ...owned(),
          ...(before === undefined ? {} : { guardLifetime: before }),
        });
      }
    }
  });

  it("unknown identities require exact verified-disposal episode/incarnation proof", () => {
    for (const before of unknown) {
      for (const current of [...unknown.filter((value) => value !== undefined), known]) {
        const state = { ...owned(), ...(before === undefined ? {} : { guardLifetime: before }) };
        const proof = {
          episode: claudeRecoveryEpisode(state),
          disposedIncarnation: 7,
          replacementIncarnation: 8,
        };
        expect(qualifyClaudeRestart(state, [], current, { proof, incarnation: 8 }).isOk()).toBe(
          true,
        );
        expect(
          qualifyClaudeRestart(state, [], current, {
            proof: { ...proof, episode: "f".repeat(64) },
            incarnation: 8,
          }).isErr(),
        ).toBe(true);
        expect(qualifyClaudeRestart(state, [], current, { proof, incarnation: 9 }).isErr()).toBe(
          true,
        );
      }
    }
  });
});

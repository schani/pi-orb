import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { MessageInputBlock, RuntimeEvent, ServerFrame } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { decideRequest } from "../domain/requests.ts";
import type { TurnSummarizer } from "../domain/turn-summary.ts";
import { runDst } from "../testkit/sim.ts";
import { PiOrbAgent, type PiSession, type PiSessionManager } from "./agent.ts";

/**
 * Operation-ID correlation under concurrent submitters (docs/pi-adapter.md).
 *
 * Two independent ingress paths can hand Pi a new turn: the live WebSocket
 * `message` action and the control plane's inbox delivery. Each is promised an
 * operation ID *before* Pi announces the turn with `agent_start`, and every
 * later status/abort/notification frame — plus the control plane's recorded
 * delivery note — is correlated by that ID. The invariant these scenarios pin
 * is therefore: **the ID promised to a submitter is the ID the turn its
 * message started actually runs under**, and a submission that merely joins a
 * running turn is reported to its submitter under that turn's ID.
 */

type Submitter = "browser" | "inbox";

/** Where a submission landed inside Pi. */
type Landing = "turn" | "steer" | "rejected";

/**
 * A schedulable stand-in for `AgentSession`, modelling the ordering the
 * pinned SDK actually has (verified against
 * `@earendil-works/pi-coding-agent@0.80.10`):
 *
 * - `sendUserMessage` → `prompt()` runs an async prologue (extension `input`
 *   hooks, auth check, compaction check) *before* `_runAgentPrompt` sets
 *   `_isAgentRunActive`. The session is therefore not streaming yet when the
 *   call returns to its caller.
 * - `sendCustomMessage` has no prologue: with `triggerTurn` on an idle
 *   session it marks the session streaming synchronously, and on a streaming
 *   session it steers instead — whatever the caller asked for.
 * - `agent_start` reaches subscribers strictly later than either of those,
 *   through `runAgentLoop` → `processEvents` → `_emitExtensionEvent`.
 */
class FakePiSession {
  private streaming = false;
  private readonly listeners: ((event: AgentSessionEvent) => void)[] = [];
  /** Turn Pi has begun but not yet announced, and who submitted it. */
  private unannounced: Submitter | null = null;
  /** Resolves the pending `sendUserMessage` prologue. */
  private prologue: (() => void) | null = null;
  /** Every submission Pi saw, in arrival order, with where it landed. */
  readonly landings: { submitter: Submitter; landing: Landing }[] = [];
  /** Submitters whose turn Pi announced, in announcement order. */
  readonly announced: Submitter[] = [];

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }

  async sendUserMessage(_content: unknown): Promise<void> {
    await new Promise<void>((resolve) => {
      this.prologue = resolve;
    });
    if (this.streaming) {
      // Pi's own words: "Agent is already processing. Specify
      // streamingBehavior ('steer' or 'followUp') to queue the message."
      this.landings.push({ submitter: "browser", landing: "rejected" });
      throw new Error("Agent is already processing.");
    }
    this.begin("browser");
  }

  async sendCustomMessage(
    _message: unknown,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    if (this.streaming) {
      this.landings.push({ submitter: "inbox", landing: "steer" });
      return;
    }
    if (options?.triggerTurn === true) this.begin("inbox");
    // The real SDK settles this promise only when the triggered turn does;
    // the classification the control plane records is fixed before that, so
    // settling early here changes when the answer arrives, not what it says.
    return;
  }

  executeBash(): Promise<never> {
    throw new Error("not used");
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  abortBash(): void {}

  /** Let the pending `sendUserMessage` prologue finish. */
  completePrologue(): void {
    const resolve = this.prologue;
    this.prologue = null;
    resolve?.();
  }

  hasPendingPrologue(): boolean {
    return this.prologue !== null;
  }

  hasUnannouncedTurn(): boolean {
    return this.unannounced !== null;
  }

  /** Emit `agent_start` for the turn Pi has begun. */
  announceStart(): void {
    const submitter = this.unannounced;
    if (submitter === null) return;
    this.unannounced = null;
    this.announced.push(submitter);
    for (const listener of this.listeners) listener({ type: "agent_start" } as AgentSessionEvent);
  }

  private begin(submitter: Submitter): void {
    this.streaming = true;
    this.unannounced = submitter;
    this.landings.push({ submitter, landing: "turn" });
  }
}

const fakeManager = (): PiSessionManager => ({
  getEntries: () => [],
  getLeafId: () => null,
  getHeader: () => ({ id: "session-under-test" }) as ReturnType<PiSessionManager["getHeader"]>,
  getSessionId: () => "session-under-test",
  getSessionFile: () => undefined,
  buildContextEntries: () => [],
});

const silentSummarizer: TurnSummarizer = { summarize: () => okAsync("") };

const text = (value: string): MessageInputBlock[] => [{ type: "text", text: value }];

interface Harness {
  readonly agent: PiOrbAgent;
  readonly pi: FakePiSession;
  /** Operation IDs the runtime broadcast `operation_started` for, in order. */
  readonly started: string[];
  /** What each submitter was promised, by the path that promised it. */
  readonly promised: Map<Submitter, { operationId: string; delivery: "turn" | "steer" }>;
}

function harness(): Harness {
  const pi = new FakePiSession();
  const agent = new PiOrbAgent({
    orbId: "orb-under-test",
    repositoryUrl: "https://example.com/repo.git",
    workDir: "/nonexistent",
    broker: null,
    turnSummarizer: silentSummarizer,
  });
  const started: string[] = [];
  agent.subscribe((frame: ServerFrame) => {
    if (frame.type !== "runtime.event") return;
    const event: RuntimeEvent = frame.event;
    if (event.type === "operation_started") started.push(event.operationId);
  });
  agent.attachSession(pi as unknown as PiSession, fakeManager(), silentSummarizer);
  return { agent, pi, started, promised: new Map() };
}

/**
 * The live WebSocket acceptance path, exactly as `http/server.ts` runs it:
 * one synchronous gate over the agent's view, an operation ID minted and
 * returned to the browser as `request.result: accepted`, then the submission.
 */
function browserSubmit(h: Harness, operationId: string): "accepted" | "busy" | "stale_head" {
  const action = {
    type: "message" as const,
    expectedHeadId: null,
    content: text("browser message"),
  };
  const decision = decideRequest(h.agent.gateView(), action);
  if (decision.type === "reject") {
    // A rejection is a legitimate outcome — the browser is told to retry —
    // as long as it is the busy gate and not a silent loss.
    expect(decision.code).toBe("busy");
    return "busy";
  }
  if (decision.type !== "start_message") return "stale_head";
  h.promised.set("browser", { operationId, delivery: "turn" });
  void h.agent.submitMessage(action.content, operationId);
  return "accepted";
}

/**
 * Every ID a submitter was promised must name the operation its own message
 * runs under: a turn it started runs under that ID, and a message that joined
 * a running turn was promised that turn's ID.
 */
function assertCorrelation(h: Harness): void {
  const turnStarters = h.pi.landings
    .filter((landing) => landing.landing === "turn")
    .map((landing) => landing.submitter);
  // Pi announces turns in the order it begins them, and the runtime
  // broadcasts one `operation_started` per announcement.
  const announced = h.pi.announced;
  expect(announced).toEqual(turnStarters.slice(0, announced.length));

  announced.forEach((submitter, index) => {
    const promise = h.promised.get(submitter);
    if (promise === undefined) return; // nobody was promised an ID (boot resume).
    expect({ submitter, delivery: promise.delivery, operationId: h.started[index] }).toEqual({
      submitter,
      delivery: "turn",
      operationId: promise.operationId,
    });
  });

  for (const { submitter, landing } of h.pi.landings) {
    const promise = h.promised.get(submitter);
    if (promise === undefined) continue;
    // A submission Pi steered must have been reported as a steer, under the
    // ID of the operation it joined.
    if (landing === "steer") {
      expect({ submitter, delivery: promise.delivery }).toEqual({ submitter, delivery: "steer" });
      expect(h.started).toContain(promise.operationId);
    }
    // An accepted submission Pi refused was silently lost.
    expect({ submitter, landing }).not.toEqual({ submitter, landing: "rejected" });
  }
}

/**
 * Drives Pi's two deferred steps as its own task so the scheduler decides
 * where the other submitter lands relative to them.
 */
async function piTask(task: SimulationTask, h: Harness): Promise<void> {
  for (let step = 0; step < 6; step++) {
    await task.checkpoint(`pi step ${step}`);
    if (h.pi.hasPendingPrologue()) h.pi.completePrologue();
    await task.checkpoint(`pi announce ${step}`);
    if (h.pi.hasUnannouncedTurn()) h.pi.announceStart();
  }
}

describe("operation-id correlation across submitters DST", () => {
  it("keeps a websocket submission's promised operation id when an inbox delivery races it", async () => {
    await runDst({ name: "operation-correlation-ws-then-inbox", iterations: 200 }, async (sim) => {
      const h = harness();
      let first = false;
      const run = await sim.runTasks([
        {
          name: "browser",
          f: async (task) => {
            // First submitter: accepted, and promised `operation-browser`.
            expect(browserSubmit(h, "operation-browser")).toBe("accepted");
            first = true;
            await task.checkpoint("browser submitted");
          },
        },
        {
          name: "inbox",
          f: async (task) => {
            // The window under test opens at the browser's acceptance and
            // closes at Pi's agent_start; where inside it this delivery lands
            // is the scheduler's choice.
            while (!first) await task.checkpoint("inbox waits for the browser submission");
            const delivered = await h.agent.deliverInboxMessage(
              "batch-1",
              ["batch-1"],
              text("inbox message"),
            );
            if (delivered.isErr()) return;
            h.promised.set("inbox", {
              operationId: delivered.value.operationId,
              delivery: delivered.value.delivery,
            });
          },
        },
        { name: "pi", f: async (task) => piTask(task, h) },
      ]);
      if (run.isErr()) throw run.error;
      assertCorrelation(h);
      // The browser owns the only turn; the delivery joins it as a steer and
      // is told so, under that turn's operation ID.
      expect(h.started).toEqual(["operation-browser"]);
      expect(h.pi.landings).toEqual([
        { submitter: "browser", landing: "turn" },
        { submitter: "inbox", landing: "steer" },
      ]);
      expect(h.promised.get("inbox")).toEqual({
        operationId: "operation-browser",
        delivery: "steer",
      });
    });
  });

  it("keeps an inbox delivery's promised operation id when a websocket submission races it", async () => {
    await runDst({ name: "operation-correlation-inbox-then-ws", iterations: 200 }, async (sim) => {
      const h = harness();
      let first = false;
      const run = await sim.runTasks([
        {
          name: "inbox",
          f: async (task) => {
            const delivered = await h.agent.deliverInboxMessage(
              "batch-1",
              ["batch-1"],
              text("inbox message"),
            );
            first = true;
            if (delivered.isErr()) return;
            h.promised.set("inbox", {
              operationId: delivered.value.operationId,
              delivery: delivered.value.delivery,
            });
            await task.checkpoint("inbox delivered");
          },
        },
        {
          name: "browser",
          f: async (task) => {
            while (!first) await task.checkpoint("browser waits for the inbox delivery");
            // The delivery owns the turn from the instant it was classified,
            // so the live gate must decline rather than promise a second one.
            expect(browserSubmit(h, "operation-browser")).toBe("busy");
          },
        },
        { name: "pi", f: async (task) => piTask(task, h) },
      ]);
      if (run.isErr()) throw run.error;
      assertCorrelation(h);
      const inbox = h.promised.get("inbox");
      expect(inbox?.delivery).toBe("turn");
      expect(h.started).toEqual([inbox?.operationId]);
      expect(h.pi.landings).toEqual([{ submitter: "inbox", landing: "turn" }]);
    });
  });
});

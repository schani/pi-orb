import type {
  DeliverOrbMessageResponse,
  HarnessSessionMetadata,
  HistoryRecord,
  PullHistoryResponse,
  RuntimeHealth,
  RuntimeHookStatus,
  RuntimeHooks,
  RuntimeTurnResume,
} from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { OrbHostProviderError, RuntimeClientError } from "../domain/errors.ts";
import type {
  DeliverMessageClientRequest,
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  OrbRuntimeClient,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
  PullHistoryClientRequest,
  StartOrbHostRequest,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

export type InitOutcome = "ready" | "failed_nonretryable" | "failed_retryable" | "never_ready";

/** Step of a scripted non-answer; see the `hang` branch of `deliverMessage`. */
const HANG_STEP_MS = 250;

/**
 * How the runtime answers `POST /messages` for one orb (docs/runtime-protocol.md).
 * `ok` is the ordinary path; the other two are the answers a queued message can
 * meet that no retry can improve on, and that therefore decide whether the
 * inbox drains or wedges:
 *
 * - `reject` — the runtime refuses the payload with a typed error. A
 *   `retryable: false` rejection (a 400 `invalid_request`, an oversized
 *   payload) is terminal for that batch: redelivering it produces the same
 *   answer forever.
 * - `hang` — the request is accepted and never answered, so the caller's own
 *   deadline ends the call while the host still observes `running`. Applied
 *   before the runtime is resolved, so it also models a delivery hanging
 *   against a runtime that has already gone dark.
 */
/**
 * The three partial-delivery kinds below are the crash windows of
 * `docs/runtime-protocol.md`'s exactly-once rule. PostgreSQL is authoritative
 * before delivery and the session file after it, so every window is defined by
 * how far the runtime got between the two:
 *
 * - `crash_before_enqueue` — the request reached the runtime, which died
 *   before touching Pi. Nothing is pending, nothing is persisted, the answer
 *   is lost: the batch must be redelivered. One-shot by construction — the
 *   crash consumes both the incarnation and the script.
 * - `enqueue_without_persist` — the batch is accepted into Pi and into this
 *   incarnation's in-memory pending set, and answered, but the session file
 *   has not been written. A retry finds it *pending* and must not enqueue it a
 *   second time; a crash before the flush loses it entirely and the control
 *   plane must redeliver. Sticky: the scenario decides whether the runtime
 *   flushes (`flushPendingInboxBatches`) or dies.
 * - `persist_without_ack` — the record is durably in the session and the
 *   *answer* is lost. The control plane never learns the classification, keeps
 *   retrying, and must not produce a second record: dedup comes from the
 *   persisted record, and the rows are marked delivered by replication.
 *   Sticky, so every retry loses its answer too.
 */
export type DeliverMessageScript =
  | { readonly kind: "ok" }
  | {
      readonly kind: "reject";
      readonly code: RuntimeClientError["code"];
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "hang"; readonly durationMs: number }
  | { readonly kind: "crash_before_enqueue" }
  | { readonly kind: "enqueue_without_persist" }
  | { readonly kind: "persist_without_ack" };

export interface FakeOrbConfig {
  /** Time from runtime start until the runtime becomes ready. */
  initDurationMs?: number;
  initOutcome?: InitOutcome;
  checkoutCommit?: string;
  /** The host runs but its container never starts: HTTP stays dark. */
  containerNeverStarts?: boolean;
  /**
   * Time from a host start/provision until its runtime container serves HTTP.
   * The host observes `running` immediately (the provider's start operation
   * completes fast), but the runtime is indistinguishable from an unreachable
   * one until then. Instant boots hid the restart livelock of
   * `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`, so the
   * default is the measured GCE figure and every scenario runs with it.
   */
  bootLatencyMs?: number;
  /** The repository's boot hooks, as this orb's checkout carries them. */
  hooks?: FakeHookConfig;
}

/**
 * `.agents/setup` and `.agents/resume` as the runtime runs them
 * (docs/orb-setup-hook.md). Setup precedes session loading and is reported as
 * the `setup_running` readiness phase for its whole duration; resume runs once
 * per runtime process after it. `absent` is a repository with no such file.
 */
export interface FakeHookConfig {
  /** How long setup holds readiness on an incarnation that has not run it. */
  setupDurationMs?: number;
  setupOutcome?: "absent" | "ok" | "failed" | "timeout" | "hook_not_executable";
  resumeOutcome?: "absent" | "ok" | "failed";
}

/** Every knob resolved, so the world never re-applies defaults while serving. */
type ResolvedOrbConfig = Omit<Required<FakeOrbConfig>, "hooks"> & {
  hooks: Required<FakeHookConfig>;
};

const DEFAULT_HOOKS: Required<FakeHookConfig> = {
  setupDurationMs: 0,
  setupOutcome: "absent",
  resumeOutcome: "absent",
};

/** The persistent filesystem: survives host stop/start and runtime restarts. */
interface FakeFilesystem {
  sessionId: string | null;
  header: HarnessSessionMetadata | null;
  entries: HistoryRecord[];
  headId: string | null;
  /**
   * Whether the flushed session tail is a *dangling turn*: a turn that was
   * in flight when the runtime process last died (docs/lifecycle.md,
   * "interrupted-turn resume at runtime boot"). The real runtime derives this
   * from the tail's shape — a trailing tool result, a trailing assistant
   * message with open tool calls, or a trailing user message with no reply —
   * which this world does not model at record granularity; `beginTurn` sets
   * the flag and `finishTurn` clears it, and the boot-time contract keys off
   * it exactly as the runtime keys off the tail.
   */
  turnInFlight: boolean;
  /**
   * The runtime's durable setup stamp (docs/orb-setup-hook.md): the compute
   * incarnation whose `.agents/setup` already ran. It lives on the workspace,
   * so a runtime restart within an incarnation does not re-run setup and a
   * replacement incarnation always does.
   */
  setupIncarnation: number | null;
  /** The persisted status file beside each hook's log: the latest outcome. */
  hooks: { setup?: RuntimeHookStatus; resume?: RuntimeHookStatus };
  /**
   * The incarnation of every setup run that reached a verdict, in order. The
   * once-per-incarnation rule is a property of this list, not of a boolean:
   * `[0, 1]` is a replacement done right, `[0, 0]` is the hook re-run on
   * compute that already paid for it (docs/orb-setup-hook.md).
   */
  setupRuns: number[];
  /** How many times `.agents/resume` reached a verdict; once per runtime process. */
  resumeRuns: number;
}

interface FakeRuntimeInstance {
  instanceId: string;
  /**
   * Monotonic ms at which the runtime process starts serving; while it lies in
   * the future the host is booting and the runtime answers nothing at all.
   */
  startedAtMonotonic: number;
  activity: "idle" | "busy";
  /**
   * Whether this incarnation has loaded the persisted session yet. The load —
   * and with it the interrupted-turn resume decision — happens once, at the
   * moment the runtime starts serving, so a process killed while still booting
   * never appends a marker and never resumes.
   */
  sessionLoaded: boolean;
  /**
   * The notable part of this incarnation's boot resume decision, reported in
   * `RuntimeHealth` exactly as the real runtime reports it, or null for an
   * ordinary boot (docs/lifecycle.md: edges, not levels).
   */
  turnResume: RuntimeTurnResume | null;
  /**
   * Inbox batches this incarnation has handed to Pi but whose record is not on
   * disk yet, keyed by durable batch ID — the runtime's in-memory
   * pending-batch set (`AgentRuntime.pendingInboxMessages`,
   * docs/runtime-protocol.md). It is consulted before enqueueing, so a retry
   * against the same incarnation never delivers twice, and it dies with the
   * process, so a crash before the flush loses the batch entirely.
   */
  pendingBatches: Map<string, PendingInboxBatch>;
  /** `.agents/resume` runs once per runtime process, after setup. */
  resumeRan: boolean;
}

/** One accepted-but-unflushed batch: content plus the classification promised for it. */
interface PendingInboxBatch {
  messageIds: readonly string[];
  text: string;
  delivery: "turn" | "steer";
  operationId: string;
}

interface FakeHost {
  ref: OrbHostRef;
  orbId: string;
  incarnation: number;
  state: OrbHostState;
  runtime: FakeRuntimeInstance | null;
  /** Deploy generation that committed this immutable specification. */
  specGeneration: number;
  /**
   * Immutable launch specification carried by this incarnation, or `null` for
   * a legacy resource created before stamps existed: "unstamped" is a state
   * the real adapters can observe (docs/compute-replacement.md rule 1), so the
   * world must be able to represent it.
   */
  specFingerprint: string | null;
  /** Per-incarnation runtime token "carried in the host's env". */
  runtimeToken: string;
  /** Monotonic ms of a hypervisor ACPI soft-off in progress, or null. */
  preemptedAtMonotonic: number | null;
  /** How long a preempted host keeps observing `running` before `stopped`. */
  preemptionSoftWindowMs: number;
}

/**
 * What the world hands back for a provisioned host. It differs from the port's
 * `ProvisionedOrbHost` in one place only: the stamp may be `null`, because the
 * world can hold a legacy unstamped resource. The provider narrows it back to
 * the port type, which a stamped provision always satisfies.
 */
export interface FakeProvisionedHost extends Omit<ProvisionedOrbHost, "specFingerprint"> {
  readonly specFingerprint: string | null;
}

/**
 * A provider-side conflict the caller cannot retry away: the resource exists
 * but carries the wrong incarnation or a specification stamp that contradicts
 * the request. All three real adapters answer this class with
 * `code: "conflict", retryable: false`, which routes the control plane into
 * the durable replacement path instead of an endless retry, so the fake must
 * distinguish it from its ordinary transient failures.
 */
class FakeProviderConflict extends Error {}

/** The deterministic stand-in for SHA-256 used by the fake provider. */
export function fakeTokenHash(token: string): string {
  return `sha256(${token})`;
}

interface OrbWorldState {
  config: ResolvedOrbConfig;
  filesystem: FakeFilesystem;
  host: FakeHost | null;
  runtimeInstanceCounter: number;
  sessionCounter: number;
  /** While > monotonic now, pulls return 503 history_unavailable. */
  pullOutageUntil: number;
  /** While > monotonic now, the runtime does not answer HTTP at all. */
  runtimeUnreachableUntil: number;
  /** When set, pull responses carry this orbId (host-routing mistake test). */
  reportOrbId: string | null;
  /** How the runtime answers inbox deliveries. */
  deliverMessageScript: DeliverMessageScript;
  /** Provider stop/start operations applied to this orb's host. */
  hostStopCount: number;
  hostStartCount: number;
  /**
   * Every compute incarnation ever *created* for this orb, in creation order,
   * with the stamp it was created with. Adoption of an existing incarnation
   * appends nothing. This is the world's own ground truth about replacement:
   * the durable row can be rewritten around untouched compute, this history
   * cannot.
   */
  createdHosts: HostCreation[];
}

/** One created compute incarnation: what the provider actually built. */
export interface HostCreation {
  readonly incarnation: number;
  readonly specFingerprint: string | null;
}

/** Measured GCE figure: ~60–70s from `instances.start` to a serving container. */
const DEFAULT_BOOT_LATENCY_MS = 65_000;

/** The soft-off window a preempted Spot VM still observes as `running`. */
const DEFAULT_PREEMPTION_SOFT_WINDOW_MS = 30_000;

/** The effective host specification a world deploys until a test changes it. */
const DEFAULT_DESIRED_SPEC = "spec-a";

/**
 * The native `customType` of the resume marker the runtime appends when it
 * picks an interrupted turn back up (docs/lifecycle.md; one
 * `sendCustomMessage(..., { triggerTurn: true, display: true })`, which the Pi
 * adapter normalizes to an `event` record — docs/pi-adapter.md).
 */
// Mirrors TURN_RESUME_CUSTOM_TYPE in apps/orb-runtime/src/pi/turn-resume.ts.
const RESUME_MARKER_CUSTOM_TYPE = "pi-orb.turn-resume";

/**
 * The record the loop guard appends instead of resuming a second time: a
 * declined resume must be as visible as a performed one (docs/lifecycle.md).
 */
// Mirrors TURN_RESUME_DECLINED_CUSTOM_TYPE in the same runtime module.
const DECLINE_MARKER_CUSTOM_TYPE = "pi-orb.turn-resume-declined";

const RESUME_MARKER_TEXT = "turn interrupted by a host restart — resuming";

const DECLINE_MARKER_TEXT = "turn interrupted again — not resuming; send a message to continue";

function hasCustomType(record: HistoryRecord, customType: string): boolean {
  if (record.type !== "event" || record.eventType !== "pi.custom_message") return false;
  const native = record.overflow["native"];
  return (
    typeof native === "object" &&
    native !== null &&
    !Array.isArray(native) &&
    native["customType"] === customType
  );
}

/** Whether a record is the runtime's interrupted-turn resume marker. */
export function isResumeMarker(record: HistoryRecord): boolean {
  return hasCustomType(record, RESUME_MARKER_CUSTOM_TYPE);
}

/** Whether a record is the runtime's declined-resume announcement. */
export function isDeclineMarker(record: HistoryRecord): boolean {
  return hasCustomType(record, DECLINE_MARKER_CUSTOM_TYPE);
}

const DEFAULT_CONFIG: ResolvedOrbConfig = {
  initDurationMs: 2_000,
  initOutcome: "ready",
  checkoutCommit: "commit-0",
  containerNeverStarts: false,
  bootLatencyMs: DEFAULT_BOOT_LATENCY_MS,
  hooks: DEFAULT_HOOKS,
};

/**
 * A deterministic world of orb hosts, runtimes, and persistent filesystems.
 * Tests drive it (append records, kill runtimes, corrupt sessions) while the
 * fake provider/client below expose it through the domain ports.
 */
export class FakeWorld {
  private readonly orbs = new Map<string, OrbWorldState>();
  private refCounter = 0;
  private computeDiscardFailuresRemaining = 0;
  private desiredSpecInput = DEFAULT_DESIRED_SPEC;

  /**
   * The fleet's current *effective* host specification — the deployed runtime
   * digest, startup contract, machine settings and so on, collapsed into one
   * opaque token. The provider hashes it with the orb's repository URL into
   * `desiredSpecFingerprint`, deliberately **without** the deploy generation:
   * an ordinary redeploy that changes nothing effective must produce the same
   * fingerprint and therefore replace nothing (docs/compute-replacement.md).
   * A scenario that wants a real host-spec update calls this.
   */
  setDesiredSpec(spec: string): void {
    this.desiredSpecInput = spec;
  }

  /** The effective specification the fleet currently deploys. */
  desiredSpec(): string {
    return this.desiredSpecInput;
  }

  configureOrb(orbId: string, config: FakeOrbConfig = {}): void {
    this.orbs.set(orbId, {
      config: { ...DEFAULT_CONFIG, ...config, hooks: { ...DEFAULT_HOOKS, ...config.hooks } },
      filesystem: {
        sessionId: null,
        header: null,
        entries: [],
        headId: null,
        turnInFlight: false,
        setupIncarnation: null,
        hooks: {},
        setupRuns: [],
        resumeRuns: 0,
      },
      host: null,
      runtimeInstanceCounter: 0,
      sessionCounter: 0,
      pullOutageUntil: 0,
      runtimeUnreachableUntil: 0,
      reportOrbId: null,
      deliverMessageScript: { kind: "ok" },
      hostStopCount: 0,
      hostStartCount: 0,
      createdHosts: [],
    });
  }

  private orbState(orbId: string): OrbWorldState {
    const state = this.orbs.get(orbId);
    if (state === undefined) throw new Error(`orb ${orbId} not configured in FakeWorld`);
    return state;
  }

  // -- test drivers ---------------------------------------------------------

  failNextComputeDiscards(count: number): void {
    this.computeDiscardFailuresRemaining = count;
  }

  consumeComputeDiscardFailure(): boolean {
    if (this.computeDiscardFailuresRemaining <= 0) return false;
    this.computeDiscardFailuresRemaining -= 1;
    return true;
  }

  /**
   * Flush one record to the orb's persistent session, as the runtime's flush
   * gate does: it is now replicable and survives the process.
   */
  private flushRecord(
    orbId: string,
    fs: FakeFilesystem,
    make: (seq: number, parentId: string | null) => HistoryRecord,
  ): HistoryRecord {
    if (fs.sessionId === null) throw new Error(`orb ${orbId} has no session yet`);
    const seq = fs.entries.length + 1;
    const record = make(seq, fs.entries.at(-1)?.id ?? null);
    fs.entries.push(record);
    fs.headId = record.id;
    return record;
  }

  private makeMessage(
    orbId: string,
    seq: number,
    parentId: string | null,
    role: "user" | "assistant",
    text: string,
  ): HistoryRecord {
    return {
      id: `${orbId}-rec-${seq}`,
      parentId,
      timestamp: `t${seq}`,
      overflow: { native: { seq } },
      type: "message",
      role,
      content: [{ type: "text", text }],
    };
  }

  /** Append a complete message record to the orb's persistent session. */
  appendMessage(orbId: string, text?: string): HistoryRecord {
    const state = this.orbState(orbId);
    const fs = state.filesystem;
    return this.flushRecord(orbId, fs, (seq, parentId) =>
      this.makeMessage(
        orbId,
        seq,
        parentId,
        seq % 2 === 1 ? "user" : "assistant",
        text ?? `message ${seq}`,
      ),
    );
  }

  /** The persisted inbox record of `batchId`, or undefined while none exists. */
  private findInboxRecord(fs: FakeFilesystem, batchId: string): HistoryRecord | undefined {
    return fs.entries.find((record) => {
      const native = record.overflow["native"];
      if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
      const details = native["details"];
      return (
        native["customType"] === "pi-orb.user-message" &&
        typeof details === "object" &&
        details !== null &&
        !Array.isArray(details) &&
        Array.isArray(details["messageIds"]) &&
        details["messageIds"][0] === batchId
      );
    });
  }

  /**
   * Flush one accepted batch to the persistent session as the Pi
   * `pi-orb.user-message` custom message: from here on the record replicates,
   * survives the process, and is what makes redelivery a no-op. A delivered
   * user message triggers a turn, so the flushed tail is a user message with
   * no reply yet — exactly the dangling shape a later boot resumes from.
   */
  appendInboxMessage(
    orbId: string,
    messageIds: readonly string[],
    text: string,
    classification?: { delivery: "turn" | "steer"; operationId: string },
  ): HistoryRecord {
    const batchId = messageIds[0] ?? "";
    const state = this.orbState(orbId);
    const existing = this.findInboxRecord(state.filesystem, batchId);
    if (existing !== undefined) return existing;
    const record = this.flushRecord(orbId, state.filesystem, (seq, parentId) => ({
      id: `${orbId}-rec-${seq}`,
      parentId,
      timestamp: `t${seq}`,
      type: "message",
      role: "user",
      content: [{ type: "text", text }],
      overflow: {
        native: {
          type: "custom_message",
          customType: "pi-orb.user-message",
          details: {
            messageIds: [...messageIds],
            ...(classification === undefined
              ? {}
              : { delivery: classification.delivery, operationId: classification.operationId }),
          },
        },
      },
    }));
    state.filesystem.turnInFlight = true;
    state.host?.runtime?.pendingBatches.delete(batchId);
    return record;
  }

  /**
   * The runtime's side of one idempotent batch delivery
   * (`AgentRuntime.deliverInboxMessage`, docs/runtime-protocol.md): consult the
   * persisted session, then this incarnation's pending set, and only then
   * enqueue. `flush` says whether the session write lands within this call or
   * whether the batch stays in memory, where a crash can still lose it.
   */
  deliverInboxBatch(
    orbId: string,
    request: { batchId: string; messageIds: readonly string[]; text: string },
    options: { flush: boolean },
  ): DeliverOrbMessageResponse {
    const state = this.orbState(orbId);
    const runtime = state.host?.runtime;
    if (runtime === undefined || runtime === null) throw new Error("deliver on dead runtime");
    const persisted = this.findInboxRecord(state.filesystem, request.batchId);
    if (persisted !== undefined) {
      const native = persisted.overflow["native"];
      const details =
        typeof native === "object" && native !== null && !Array.isArray(native)
          ? native["details"]
          : undefined;
      const read =
        typeof details === "object" && details !== null && !Array.isArray(details) ? details : {};
      return {
        v: 1,
        messageId: request.batchId,
        status: "persisted",
        delivery: read["delivery"] === "steer" ? "steer" : "turn",
        operationId: typeof read["operationId"] === "string" ? read["operationId"] : "unknown",
        duplicate: true,
      };
    }
    const pending = runtime.pendingBatches.get(request.batchId);
    if (pending !== undefined) {
      return {
        v: 1,
        messageId: request.batchId,
        status: "queued",
        delivery: pending.delivery,
        operationId: pending.operationId,
        duplicate: true,
      };
    }
    const delivery = runtime.activity === "busy" ? ("steer" as const) : ("turn" as const);
    const operationId = `message-${request.batchId}`;
    runtime.pendingBatches.set(request.batchId, {
      messageIds: request.messageIds,
      text: request.text,
      delivery,
      operationId,
    });
    runtime.activity = "busy";
    if (options.flush) {
      this.appendInboxMessage(orbId, request.messageIds, request.text, { delivery, operationId });
    }
    return {
      v: 1,
      messageId: request.batchId,
      status: "queued",
      delivery,
      operationId,
      duplicate: false,
    };
  }

  /** Batch IDs the live runtime holds accepted but unflushed, in insertion order. */
  pendingInboxBatchesOf(orbId: string): readonly string[] {
    return [...(this.orbState(orbId).host?.runtime?.pendingBatches.keys() ?? [])];
  }

  /** The runtime's flush gate runs: every pending batch reaches the session file. */
  flushPendingInboxBatches(orbId: string): void {
    const runtime = this.orbState(orbId).host?.runtime;
    if (runtime === null || runtime === undefined) return;
    for (const [, pending] of [...runtime.pendingBatches]) {
      this.appendInboxMessage(orbId, pending.messageIds, pending.text, {
        delivery: pending.delivery,
        operationId: pending.operationId,
      });
    }
  }

  /**
   * The `crash_before_enqueue` window: the incarnation handling a delivery dies
   * before it touches Pi and its supervisor restarts it in place. Everything
   * in memory — the pending batch set above — dies with it. The script is
   * consumed along with the incarnation: a crash window is one-shot by
   * construction, and a scenario that wants a second one scripts it again.
   */
  crashRuntimeBeforeEnqueue(task: SimulationTask, orbId: string): void {
    this.restartRuntimeProcess(task, orbId);
    this.orbState(orbId).deliverMessageScript = { kind: "ok" };
  }

  /**
   * Start an agent turn: flush the user message that triggers it and leave the
   * runtime `busy` with the turn in flight. Until `finishTurn`, every death of
   * the runtime process leaves the session tail dangling, which is what the
   * next boot resumes from (docs/lifecycle.md).
   */
  beginTurn(orbId: string, text?: string): HistoryRecord {
    const state = this.orbState(orbId);
    const fs = state.filesystem;
    const record = this.flushRecord(orbId, fs, (seq, parentId) =>
      this.makeMessage(orbId, seq, parentId, "user", text ?? `turn ${seq}`),
    );
    fs.turnInFlight = true;
    const runtime = state.host?.runtime;
    if (runtime !== null && runtime !== undefined) {
      // A runtime that accepts a message has its session loaded by
      // definition, so this incarnation is past its own resume decision.
      runtime.sessionLoaded = true;
      runtime.activity = "busy";
    }
    return record;
  }

  /** The turn completes normally: a closing assistant message, runtime idle. */
  finishTurn(orbId: string, text?: string): HistoryRecord {
    const state = this.orbState(orbId);
    const fs = state.filesystem;
    const record = this.flushRecord(orbId, fs, (seq, parentId) =>
      this.makeMessage(orbId, seq, parentId, "assistant", text ?? `turn ${seq} done`),
    );
    fs.turnInFlight = false;
    this.setActivity(orbId, "idle");
    return record;
  }

  /** Every resume marker the runtime has appended to this orb's session. */
  resumeMarkersOf(orbId: string): readonly HistoryRecord[] {
    return this.orbState(orbId).filesystem.entries.filter(isResumeMarker);
  }

  /** Every declined-resume record the runtime has appended to this session. */
  declineMarkersOf(orbId: string): readonly HistoryRecord[] {
    return this.orbState(orbId).filesystem.entries.filter(isDeclineMarker);
  }

  entriesOf(orbId: string): readonly HistoryRecord[] {
    return this.orbState(orbId).filesystem.entries;
  }

  sessionHeaderOf(orbId: string): HarnessSessionMetadata | null {
    return this.orbState(orbId).filesystem.header;
  }

  /**
   * The host state as the provider would report it. A preemption soft-off
   * materializes on observation, so a test that watches for the `stopped` edge
   * needs a reconciler (or its own `observeHost`) running alongside.
   */
  hostStateOf(orbId: string): OrbHostState | null {
    return this.orbState(orbId).host?.state ?? null;
  }

  /** The runtime incarnation the host will serve, booted or still booting. */
  runtimeInstanceIdOf(orbId: string): string | null {
    return this.orbState(orbId).host?.runtime?.instanceId ?? null;
  }

  /** Whether the orb's runtime answers HTTP right now (boot latency elapsed). */
  isRuntimeServing(task: SimulationTask, orbId: string): boolean {
    const state = this.orbState(orbId);
    const host = state.host;
    if (host === null || host.state !== "running") return false;
    this.loadSessionIfServing(task, state);
    return host.runtime !== null && host.runtime.startedAtMonotonic <= task.monotonicNow();
  }

  /** Provider stop operations applied to the orb's host so far. */
  hostStopCountOf(orbId: string): number {
    return this.orbState(orbId).hostStopCount;
  }

  /** Provider start operations applied to the orb's host so far. */
  hostStartCountOf(orbId: string): number {
    return this.orbState(orbId).hostStartCount;
  }

  setActivity(orbId: string, activity: "idle" | "busy"): void {
    const runtime = this.orbState(orbId).host?.runtime;
    if (runtime !== null && runtime !== undefined) runtime.activity = activity;
  }

  /**
   * Simulate a runtime-process crash and supervised restart inside the host.
   * The host itself never went down, so this pays no boot latency — but the
   * new process still loads the session, so the interrupted-turn resume
   * applies exactly as it does after a host boot.
   */
  restartRuntimeProcess(task: SimulationTask, orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host === null || state.host.state !== "running") return;
    state.runtimeInstanceCounter += 1;
    state.host.runtime = {
      instanceId: `${orbId}-runtime-${state.runtimeInstanceCounter}`,
      startedAtMonotonic: task.monotonicNow(),
      activity: "idle",
      sessionLoaded: false,
      turnResume: null,
      pendingBatches: new Map(),
      resumeRan: false,
    };
  }

  /** Kill the runtime process without restart: HTTP goes dark until host restart. */
  killRuntimeProcess(orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host !== null) state.host.runtime = null;
  }

  /**
   * A hypervisor ACPI soft-off (the shape of a Spot preemption, see
   * `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`): the runtime
   * goes dark at once while the instance still observes as `running` for
   * `softWindowMs`, and only then as `stopped`. A stop or start of the host in
   * between overrides the soft-off, exactly as `instances.stop` does in GCE.
   */
  preemptHost(
    task: SimulationTask,
    orbId: string,
    softWindowMs: number = DEFAULT_PREEMPTION_SOFT_WINDOW_MS,
  ): void {
    const host = this.orbState(orbId).host;
    if (host === null || host.state !== "running") return;
    host.runtime = null;
    host.preemptedAtMonotonic = task.monotonicNow();
    host.preemptionSoftWindowMs = softWindowMs;
  }

  /** Fast-forward an in-flight boot: the runtime serves from now on. */
  finishBoot(task: SimulationTask, orbId: string): void {
    const runtime = this.orbState(orbId).host?.runtime;
    if (runtime !== null && runtime !== undefined) {
      runtime.startedAtMonotonic = task.monotonicNow();
    }
  }

  /** How the orb's runtime answers inbox deliveries from now on. */
  scriptDeliverMessage(orbId: string, script: DeliverMessageScript): void {
    this.orbState(orbId).deliverMessageScript = script;
  }

  /**
   * The delivery script of the orb whose host answers `baseUrl`. Deliberately
   * not routed through `resolveRuntime`: a scripted rejection or hang is the
   * answer the *host* gives, and must apply even while the runtime process
   * behind it is dark.
   */
  deliverMessageScriptOf(baseUrl: string): DeliverMessageScript | null {
    for (const state of this.orbs.values()) {
      const host = state.host;
      if (host !== null && `http://${host.ref.resourceId}:8080` === baseUrl) {
        return state.deliverMessageScript;
      }
    }
    return null;
  }

  setPullOutage(task: SimulationTask, orbId: string, durationMs: number): void {
    this.orbState(orbId).pullOutageUntil = task.monotonicNow() + durationMs;
  }

  setRuntimeUnreachable(task: SimulationTask, orbId: string, durationMs: number): void {
    this.orbState(orbId).runtimeUnreachableUntil = task.monotonicNow() + durationMs;
  }

  /** Corrupt the persisted session header: the next pull reports a different session. */
  corruptSession(orbId: string): void {
    const fs = this.orbState(orbId).filesystem;
    if (fs.sessionId === null) throw new Error(`orb ${orbId} has no session to corrupt`);
    fs.sessionId = `${fs.sessionId}-corrupt`;
    fs.header = {
      id: fs.sessionId,
      overflow: { native: { id: fs.sessionId } },
    };
  }

  /** Truncate persisted entries so committed cursors dangle (cursor_not_found). */
  truncateEntries(orbId: string, keep: number): void {
    const fs = this.orbState(orbId).filesystem;
    fs.entries = fs.entries.slice(0, keep);
    fs.headId = fs.entries.at(-1)?.id ?? null;
  }

  reportWrongOrbId(orbId: string, reportedOrbId: string): void {
    this.orbState(orbId).reportOrbId = reportedOrbId;
  }

  /** Count of hosts that exist (any state) for invariant checks. */
  hostCount(orbId: string): number {
    return this.orbs.get(orbId)?.host === null || !this.orbs.has(orbId) ? 0 : 1;
  }

  filesystemExists(orbId: string): boolean {
    return this.orbs.has(orbId);
  }

  discardCompute(orbId: string, throughIncarnation: number): void {
    const state = this.orbs.get(orbId);
    if (state === undefined || state.host === null || state.host.incarnation > throughIncarnation) {
      return;
    }
    state.host = null;
  }

  destroyOrb(orbId: string): void {
    this.orbs.delete(orbId);
  }

  // -- internal transitions used by the provider ----------------------------

  /** Create the persistent session if none exists (as a ready runtime would). */
  ensureSessionExists(orbId: string): void {
    const state = this.orbState(orbId);
    const fs = state.filesystem;
    if (fs.sessionId === null) {
      state.sessionCounter += 1;
      fs.sessionId = `${orbId}-session-${state.sessionCounter}`;
      fs.header = { id: fs.sessionId, overflow: { native: { id: fs.sessionId } } };
    }
  }

  /**
   * Create or idempotently adopt this orb's compute, exactly as the real
   * adapters do: an existing incarnation is reused (and started if it was
   * down) and its token read back, while a wrong incarnation or a stamp that
   * contradicts the requested specification is a non-retryable conflict that
   * only the durable replacement path can resolve — never an in-place repair
   * and never a silent adoption (docs/compute-replacement.md).
   *
   * `specFingerprint` is required and may be `null` to create the legacy
   * unstamped cohort; there is deliberately no default, because a default that
   * differed from the provider's own `desiredSpecFingerprint` made every
   * seeded host look stale to the very code under test.
   */
  provisionHost(
    task: SimulationTask,
    orbId: string,
    incarnation: number,
    specGeneration: number,
    specFingerprint: string | null,
  ): FakeProvisionedHost {
    const state = this.orbState(orbId);
    if (state.host !== null) {
      if (state.host.incarnation !== incarnation) {
        // A provision that meets live compute of another incarnation means the
        // caller skipped required disposal; adopting it silently would mask
        // exactly the bug class the discard fence exists to prevent. GCE
        // answers the same situation with "racing incarnation mismatch".
        throw new FakeProviderConflict(
          `orb ${orbId} requested incarnation ${incarnation} ` +
            `while incarnation ${state.host.incarnation} still exists`,
        );
      }
      if (state.host.specFingerprint !== specFingerprint) {
        // All three real adapters refuse here (Docker "container specification
        // mismatch", GCE "instance specification mismatch", process "process
        // specification mismatch"): stale compute is replaced, never adopted.
        throw new FakeProviderConflict(
          `orb ${orbId} host carries specification ${String(state.host.specFingerprint)}, ` +
            `expected ${String(specFingerprint)}`,
        );
      }
      // Idempotent: return the existing host (starting it if stopped) and
      // read its token back — never re-mint for an existing incarnation.
      if (state.host.state === "stopped" || state.host.state === "failed") {
        this.startHost(task, state.host.ref);
      }
      return {
        ref: state.host.ref,
        incarnation: state.host.incarnation,
        runtimeTokenHash: fakeTokenHash(state.host.runtimeToken),
        specFingerprint: state.host.specFingerprint,
        specGeneration: state.host.specGeneration,
      };
    }
    this.refCounter += 1;
    const ref: OrbHostRef = {
      provider: "fake",
      resourceId: `host-${orbId}-i${incarnation}-${this.refCounter}`,
    };
    const runtimeToken = `token-${orbId}-${this.refCounter}`;
    state.host = {
      ref,
      orbId,
      incarnation,
      state: "running",
      runtime: null,
      runtimeToken,
      specGeneration,
      specFingerprint,
      preemptedAtMonotonic: null,
      preemptionSoftWindowMs: DEFAULT_PREEMPTION_SOFT_WINDOW_MS,
    };
    state.createdHosts.push({ incarnation, specFingerprint });
    state.hostStartCount += 1;
    this.bootRuntime(task, orbId);
    return {
      ref,
      incarnation,
      runtimeTokenHash: fakeTokenHash(runtimeToken),
      specFingerprint,
      specGeneration,
    };
  }

  /** The orb's host reference, or null when it has none. */
  hostRefOf(orbId: string): OrbHostRef | null {
    return this.orbState(orbId).host?.ref ?? null;
  }

  /** The host vanishes entirely (manual removal, definitive absence). */
  removeHost(orbId: string): void {
    this.orbState(orbId).host = null;
  }

  /**
   * The specification stamp the *actual* compute carries, which is what the
   * durable row claims to describe. Asserting on the store row alone cannot
   * tell a real replacement from a row rewritten around untouched compute.
   */
  specFingerprintOf(orbId: string): string | null {
    return this.orbState(orbId).host?.specFingerprint ?? null;
  }

  /** Every compute incarnation this world has created for the orb, in order. */
  createdHostsOf(orbId: string): readonly HostCreation[] {
    return this.orbState(orbId).createdHosts;
  }

  /** The incarnation the orb's actual compute carries, or null with no host. */
  hostIncarnationOf(orbId: string): number | null {
    return this.orbState(orbId).host?.incarnation ?? null;
  }

  /** The incarnation whose `.agents/setup` has run, from the durable stamp. */
  setupIncarnationOf(orbId: string): number | null {
    return this.orbState(orbId).filesystem.setupIncarnation;
  }

  /** The persisted boot-hook statuses, as the runtime would report them. */
  hookStatusesOf(orbId: string): { setup?: RuntimeHookStatus; resume?: RuntimeHookStatus } {
    return { ...this.orbState(orbId).filesystem.hooks };
  }

  /** The incarnation of every completed setup run, in order. */
  setupRunsOf(orbId: string): readonly number[] {
    return [...this.orbState(orbId).filesystem.setupRuns];
  }

  /** How many times `.agents/resume` has run for this orb. */
  resumeRunsOf(orbId: string): number {
    return this.orbState(orbId).filesystem.resumeRuns;
  }

  /**
   * Rewrite the live host's stamp behind the control plane's back: the durable
   * row now describes compute that does not exist as recorded. That is the
   * drift the post-observation forced replacement exists for (a resource
   * replaced out of band, a row committed by another revision).
   */
  setHostSpecFingerprint(orbId: string, specFingerprint: string | null): void {
    const host = this.orbState(orbId).host;
    if (host === null) throw new Error(`orb ${orbId} has no host to restamp`);
    host.specFingerprint = specFingerprint;
  }

  hostTokenOf(orbId: string): string | null {
    return this.orbState(orbId).host?.runtimeToken ?? null;
  }

  private readonly diagnoses = new Map<string, string>();

  /** Host-side evidence returned by the fake provider's diagnose(). */
  setDiagnosis(orbId: string, message: string): void {
    this.diagnoses.set(orbId, message);
  }

  diagnosisOf(orbId: string): string | null {
    return this.diagnoses.get(orbId) ?? null;
  }

  startHost(task: SimulationTask, ref: OrbHostRef): void {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return;
    state.hostStartCount += 1;
    state.host.preemptedAtMonotonic = null;
    if (state.host.state === "running") return;
    state.host.state = "running";
    this.bootRuntime(task, state.host.orbId);
  }

  stopHost(ref: OrbHostRef): void {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return;
    state.hostStopCount += 1;
    state.host.preemptedAtMonotonic = null;
    state.host.state = "stopped";
    state.host.runtime = null;
  }

  /**
   * Start the runtime container. It only serves after the configured boot
   * latency; until then the host is up but nothing answers on port 8080.
   */
  private bootRuntime(task: SimulationTask, orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host === null) return;
    if (state.config.containerNeverStarts) return;
    const fs = state.filesystem;
    if (fs.sessionId !== null && fs.entries.length === 0) {
      // Post-flush-gate runtime contract (docs/history-replication.md): a session that
      // never flushed a record evaporates with the process — the next boot
      // starts a fresh session identity.
      fs.sessionId = null;
      fs.header = null;
      fs.headId = null;
      // Nothing of the turn reached the disk, so nothing can be resumed from it.
      fs.turnInFlight = false;
    }
    state.runtimeInstanceCounter += 1;
    state.host.runtime = {
      instanceId: `${orbId}-runtime-${state.runtimeInstanceCounter}`,
      startedAtMonotonic: task.monotonicNow() + state.config.bootLatencyMs,
      // The session is loaded (and any interrupted turn resumed) when this
      // incarnation starts serving, not now: see `loadSessionIfServing`.
      activity: "idle",
      sessionLoaded: false,
      turnResume: null,
      pendingBatches: new Map(),
      resumeRan: false,
    };
  }

  /**
   * The runtime's boot-time **interrupted-turn resume** (docs/lifecycle.md,
   * decided 2026-08-07), applied once per incarnation at the instant it starts
   * serving — the runtime has loaded the persisted session by then, and the
   * marker must be visible to a pull exactly when the runtime answers one.
   *
   * The contract, cause-agnostically (preemption, unreachable restart, user
   * stop/start and idle auto-stop are indistinguishable on disk):
   *
   * - flushed tail is a dangling turn and no resume marker follows the last
   *   real user message → append the marker record and come up `busy`, the
   *   turn continues;
   * - flushed tail is a dangling turn *under* a marker → the guard declines:
   *   come up `idle`, and announce the decline with its own record, at most
   *   one per interruption. A turn that crashes its host again after resuming
   *   is not resumed a second time, and never silently;
   * - anything else → come up `idle` and report nothing.
   *
   * Either notable decision is reported in this incarnation's health, as the
   * real runtime reports it: the readiness path logs it once per boot.
   */
  private loadSessionIfServing(task: SimulationTask, state: OrbWorldState): void {
    const host = state.host;
    if (host === null || host.state !== "running") return;
    const runtime = host.runtime;
    if (runtime === null || runtime.sessionLoaded) return;
    if (runtime.startedAtMonotonic > task.monotonicNow()) return;
    runtime.sessionLoaded = true;
    const fs = state.filesystem;
    if (!fs.turnInFlight || fs.sessionId === null) return;
    // The head the decision keys off: the last record that is not pi-orb's own
    // bookkeeping, which is what the runtime's detection walks back to.
    const headRecordId = fs.entries.findLast(
      (record) => !isResumeMarker(record) && !isDeclineMarker(record),
    )?.id;
    // The world flushes no partial assistant output, so the dangling tail it
    // models is always the turn's user message with no reply at all.
    const shape = "unanswered_user_message" as const;
    if (!this.hasMarkerAfterLastUserMessage(fs, isResumeMarker)) {
      this.flushMarkerRecord(host.orbId, fs, "resume");
      runtime.activity = "busy";
      runtime.turnResume = {
        outcome: "resumed",
        shape,
        ...(headRecordId !== undefined ? { headRecordId } : {}),
      };
      return;
    }
    // The guard is suppressing a resume; health says so on every boot that
    // declines, the record only on the first.
    runtime.turnResume = {
      outcome: "declined_already_resumed",
      shape,
      ...(headRecordId !== undefined ? { headRecordId } : {}),
    };
    if (this.hasMarkerAfterLastUserMessage(fs, isDeclineMarker)) return;
    this.flushMarkerRecord(host.orbId, fs, "decline");
  }

  /**
   * One of the runtime's own custom-message records, flushed to the session.
   * The resume marker triggers the continued turn; the decline record is
   * visible but deliberately inert.
   */
  private flushMarkerRecord(orbId: string, fs: FakeFilesystem, kind: "resume" | "decline"): void {
    const resuming = kind === "resume";
    const customType = resuming ? RESUME_MARKER_CUSTOM_TYPE : DECLINE_MARKER_CUSTOM_TYPE;
    const text = resuming ? RESUME_MARKER_TEXT : DECLINE_MARKER_TEXT;
    this.flushRecord(orbId, fs, (seq, parentId) => ({
      id: `${orbId}-${kind}-${seq}`,
      parentId,
      timestamp: `t${seq}`,
      overflow: { native: { seq, customType, display: true, triggerTurn: resuming } },
      type: "event",
      eventType: "pi.custom_message",
      content: [{ type: "text", text }],
    }));
  }

  /** The loop guard's key: does such a record follow the last user message? */
  private hasMarkerAfterLastUserMessage(
    fs: FakeFilesystem,
    isMarker: (record: HistoryRecord) => boolean,
  ): boolean {
    let lastUserMessage = -1;
    fs.entries.forEach((record, index) => {
      if (record.type === "message" && record.role === "user") lastUserMessage = index;
    });
    return fs.entries.some((record, index) => index > lastUserMessage && isMarker(record));
  }

  /** Apply an elapsed preemption soft-off window: the instance is now down. */
  private settlePreemption(task: SimulationTask, host: FakeHost): void {
    if (host.preemptedAtMonotonic === null) return;
    if (task.monotonicNow() - host.preemptedAtMonotonic < host.preemptionSoftWindowMs) return;
    host.preemptedAtMonotonic = null;
    host.state = "stopped";
    host.runtime = null;
  }

  findByRef(ref: OrbHostRef): OrbWorldState | null {
    for (const state of this.orbs.values()) {
      if (state.host?.ref.resourceId === ref.resourceId) return state;
    }
    return null;
  }

  observeHost(task: SimulationTask, ref: OrbHostRef): OrbHostObservation | null {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return null;
    this.settlePreemption(task, state.host);
    const observation: OrbHostObservation = {
      ref: state.host.ref,
      orbId: state.host.orbId,
      incarnation: state.host.incarnation,
      specFingerprint: state.host.specFingerprint,
      state: state.host.state,
      ...(state.host.state === "running"
        ? { runtimeAddress: { baseUrl: `http://${state.host.ref.resourceId}:8080` } }
        : {}),
    };
    return observation;
  }

  listHosts(task: SimulationTask): OrbHostObservation[] {
    const result: OrbHostObservation[] = [];
    for (const state of this.orbs.values()) {
      if (state.host !== null) {
        const observation = this.observeHost(task, state.host.ref);
        if (observation !== null) result.push(observation);
      }
    }
    return result;
  }

  // -- runtime protocol view -----------------------------------------------

  /**
   * The runtime behind a base URL, or null when nothing answers there. A host
   * still inside its boot latency resolves to null just like a dead one: the
   * container is not listening yet, so health checks and pulls see exactly the
   * same unreachable runtime.
   */
  resolveRuntime(baseUrl: string, task: SimulationTask): OrbWorldState | null {
    for (const state of this.orbs.values()) {
      const host = state.host;
      if (host === null || `http://${host.ref.resourceId}:8080` !== baseUrl) continue;
      // A request that arrives after the boot latency finds a runtime that has
      // loaded its session — and resumed any interrupted turn — by now.
      this.loadSessionIfServing(task, state);
      if (
        host.state === "running" &&
        host.runtime !== null &&
        host.runtime.startedAtMonotonic <= task.monotonicNow() &&
        state.runtimeUnreachableUntil <= task.monotonicNow()
      ) {
        return state;
      }
    }
    return null;
  }

  runtimeHealth(task: SimulationTask, state: OrbWorldState): RuntimeHealth {
    const host = state.host;
    if (host === null || host.runtime === null) throw new Error("runtimeHealth on dead runtime");
    const runtime = host.runtime;
    const orbId = state.reportOrbId ?? host.orbId;
    const elapsed = task.monotonicNow() - runtime.startedAtMonotonic;
    const fs = state.filesystem;
    // The repository's `.agents/setup` runs before the session is loaded and
    // holds readiness for its whole duration (docs/orb-setup-hook.md).
    const setupPending =
      state.config.hooks.setupOutcome !== "absent" && fs.setupIncarnation !== host.incarnation;
    const setupWindowMs = setupPending ? state.config.hooks.setupDurationMs : 0;
    const hooks = (): { hooks?: RuntimeHooks } =>
      fs.hooks.setup === undefined && fs.hooks.resume === undefined
        ? {}
        : { hooks: { ...fs.hooks } };
    if (elapsed < setupWindowMs) {
      return {
        v: 1,
        orbId,
        runtimeInstanceId: runtime.instanceId,
        status: "initializing",
        phase: "setup_running",
        ...hooks(),
      };
    }
    this.settleBootHooks(task, state, host.incarnation, setupPending, setupWindowMs);
    const initializing: RuntimeHealth = {
      v: 1,
      orbId,
      runtimeInstanceId: runtime.instanceId,
      status: "initializing",
      phase: "loading_session",
      ...hooks(),
    };
    if (elapsed < setupWindowMs + state.config.initDurationMs) return initializing;
    switch (state.config.initOutcome) {
      case "never_ready":
        return initializing;
      case "failed_nonretryable":
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "failed",
          error: { code: "session_load_failed", message: "session corrupt", retryable: false },
        };
      case "failed_retryable":
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "failed",
          error: { code: "clone_failed", message: "network flake", retryable: true },
        };
      case "ready": {
        this.ensureSessionExists(host.orbId);
        if (fs.sessionId === null) throw new Error("session must exist when ready");
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "ready",
          sessionId: fs.sessionId,
          checkoutCommit: state.config.checkoutCommit,
          activity: runtime.activity,
          ...(runtime.turnResume !== null ? { turnResume: runtime.turnResume } : {}),
          ...hooks(),
        };
      }
    }
  }

  /**
   * Record the outcomes of the hooks whose window has just closed: setup once
   * per incarnation (stamped on the persistent filesystem), resume once per
   * runtime process, always after setup. Both statuses persist beside their
   * logs, so a runtime restart still reports the last run's verdict.
   */
  private settleBootHooks(
    task: SimulationTask,
    state: OrbWorldState,
    incarnation: number,
    setupPending: boolean,
    setupWindowMs: number,
  ): void {
    const fs = state.filesystem;
    const config = state.config.hooks;
    // The real runtime timestamps a hook from when it spawned it, not from the
    // health poll that noticed it finished — and the control plane's hold
    // reseeds itself from exactly that number after a process restart
    // (docs/orb-setup-hook.md), so the model has to be honest about it.
    const runtimeStartedAtWall =
      task.wallNow() - (task.monotonicNow() - (state.host?.runtime?.startedAtMonotonic ?? 0));
    const status = (
      hook: "setup" | "resume",
      outcome: Exclude<FakeHookConfig["setupOutcome"], "absent" | undefined>,
      startedAtWall: number,
      endedAtWall: number,
    ): RuntimeHookStatus => ({
      hook,
      outcome,
      exitCode: outcome === "failed" ? 1 : null,
      incarnation: String(incarnation),
      startedAt: new Date(startedAtWall).toISOString(),
      endedAt: new Date(endedAtWall).toISOString(),
      logPath: `/workspace/home/.cache/pi-orb/logs/${hook}.log`,
    });
    if (setupPending && config.setupOutcome !== "absent") {
      fs.setupIncarnation = incarnation;
      fs.setupRuns.push(incarnation);
      fs.hooks.setup = status(
        "setup",
        config.setupOutcome,
        runtimeStartedAtWall,
        runtimeStartedAtWall + setupWindowMs,
      );
    }
    const runtime = state.host?.runtime ?? null;
    if (runtime === null || runtime.resumeRan) return;
    runtime.resumeRan = true;
    if (config.resumeOutcome !== "absent") {
      fs.resumeRuns += 1;
      const resumeStartedAt = runtimeStartedAtWall + setupWindowMs;
      fs.hooks.resume = status("resume", config.resumeOutcome, resumeStartedAt, resumeStartedAt);
    }
  }
}

// ---------------------------------------------------------------------------

const providerError = (
  operation: OrbHostProviderError["operation"],
  code: OrbHostProviderError["code"],
  message: string,
  retryable: boolean,
): OrbHostProviderError => ({
  type: "orb_host_provider_error",
  provider: "fake",
  operation,
  code,
  message,
  retryable,
});

export class FakeOrbHostProvider implements OrbHostProvider {
  readonly kind = "fake";
  readonly specGeneration: number;
  private readonly world: FakeWorld;
  private readonly maxLatencyMs: number;
  private readonly desiredSpecOverride: string | null;

  /**
   * `desiredSpec` pins this provider's effective specification instead of
   * following the world's current one — how a scenario models two revisions
   * that deploy *different* specifications at the same time. It is independent
   * of `specGeneration`, which only fences which revision may replace forward.
   */
  constructor(
    world: FakeWorld,
    maxLatencyMs: number = 50,
    specGeneration: number = 0,
    desiredSpec: string | null = null,
  ) {
    this.world = world;
    this.maxLatencyMs = maxLatencyMs;
    this.specGeneration = specGeneration;
    this.desiredSpecOverride = desiredSpec;
  }

  /**
   * The pure fingerprint calculation of docs/compute-replacement.md: it hashes
   * the effective specification with the orb's repository URL and nothing
   * else. The deploy generation is deliberately not an input — an ordinary
   * redeploy of an unchanged specification must leave the fleet alone.
   */
  desiredSpecFingerprint(input: {
    readonly orbId: string;
    readonly repositoryUrl: string;
  }): string {
    const spec = this.desiredSpecOverride ?? this.world.desiredSpec();
    return `fake-spec-${spec}:${input.repositoryUrl}`;
  }

  private op<T>(
    task: SimulationTask,
    operation: OrbHostProviderError["operation"],
    failpoint: string,
    context: OperationContext,
    f: () => T | Promise<T>,
  ): ResultAsync<T, OrbHostProviderError> {
    const run = async (): Promise<T> => {
      await task.sleep(
        1 + task.random(`provider latency: ${operation}`) * this.maxLatencyMs,
        `provider ${operation}`,
        { signal: context.signal },
      );
      await task.failpoint(failpoint, operation);
      return f();
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof FakeProviderConflict) {
        // Retrying cannot change the answer: the resource is what it is, and
        // only durable replacement moves this orb forward.
        return providerError(operation, "conflict", error.message, false);
      }
      if (error instanceof ApplicationFailure) {
        return providerError(operation, "unavailable", error.message, true);
      }
      // Cancellation (deadline) or anything else: typed `cancelled`.
      return providerError(operation, "cancelled", String(error), true);
    });
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError> {
    return this.op(task, "provision", FAILPOINTS.providerProvision, context, async () => {
      const specFingerprint = this.desiredSpecFingerprint({
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
      });
      const host = this.world.provisionHost(
        task,
        request.orbId,
        request.incarnation,
        this.specGeneration,
        specFingerprint,
      );
      // The world either created this host with the requested stamp or adopted
      // one already carrying it; any other stamp conflicted above.
      return { ...host, specFingerprint };
    });
  }

  start(
    task: SimulationTask,
    request: StartOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "start", FAILPOINTS.providerStart, context, async () => {
      const state = this.world.findByRef(request.ref);
      const host = state?.host;
      if (host === null || host === undefined) {
        // Absence is transient from the reconciler's viewpoint, as the GCE
        // adapter documents: the next observe sees null and reprovisions.
        throw new ApplicationFailure("host is absent");
      }
      // Both remaining checks precede any state change, as in the real
      // adapters: a wrong-incarnation or stale-spec resource must never be
      // started, and no number of retries makes it startable. A `null`
      // expectation matches an unstamped legacy resource and nothing else.
      if (host.incarnation !== request.expectedIncarnation) {
        throw new FakeProviderConflict("host incarnation mismatch");
      }
      if (host.specFingerprint !== request.expectedSpecFingerprint) {
        throw new FakeProviderConflict("host specification mismatch");
      }
      this.world.startHost(task, request.ref);
    });
  }

  stop(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "stop", FAILPOINTS.providerStop, context, () => this.world.stopHost(ref));
  }

  discardCompute(
    task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "discard", FAILPOINTS.providerDiscard, context, () => {
      if (this.world.consumeComputeDiscardFailure()) {
        throw new ApplicationFailure("scripted compute discard failure");
      }
      this.world.discardCompute(request.orbId, request.throughIncarnation);
    });
  }

  destroy(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "destroy", FAILPOINTS.providerDestroy, context, () =>
      this.world.destroyOrb(orbId),
    );
  }

  observe(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError> {
    return this.op(task, "observe", FAILPOINTS.providerObserve, context, () =>
      this.world.observeHost(task, ref),
    );
  }

  listManagedHosts(
    task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError> {
    return this.op(task, "list", FAILPOINTS.providerObserve, context, () =>
      this.world.listHosts(task),
    );
  }

  diagnose(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError> {
    return this.op(task, "observe", FAILPOINTS.providerObserve, context, () => {
      const state = this.world.findByRef(ref);
      if (state === null || state.host === null) return null;
      return this.world.diagnosisOf(state.host.orbId);
    });
  }
}

// ---------------------------------------------------------------------------

const clientError = (
  code: RuntimeClientError["code"],
  message: string,
  retryable: boolean,
): RuntimeClientError => ({ type: "runtime_client_error", code, message, retryable });

export class FakeRuntimeClient implements OrbRuntimeClient {
  private readonly world: FakeWorld;
  private readonly maxLatencyMs: number;

  constructor(world: FakeWorld, maxLatencyMs: number = 20) {
    this.world = world;
    this.maxLatencyMs = maxLatencyMs;
  }

  private req<T>(
    task: SimulationTask,
    failpoint: string,
    reason: string,
    context: OperationContext,
    f: () => ResultAsync<T, RuntimeClientError>,
  ): ResultAsync<T, RuntimeClientError> {
    const run = async (): Promise<void> => {
      await task.sleep(1 + task.random(`runtime latency: ${reason}`) * this.maxLatencyMs, reason, {
        signal: context.signal,
      });
      await task.failpoint(failpoint, reason);
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return clientError("unreachable", `${reason}: ${error.message}`, true);
      }
      return clientError("cancelled", `${reason}: cancelled`, true);
    }).andThen(f);
  }

  deliverMessage(
    task: SimulationTask,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").DeliverOrbMessageResponse, RuntimeClientError> {
    return this.req(task, FAILPOINTS.runtimeDeliverMessage, "deliver message", context, () => {
      const script = this.world.deliverMessageScriptOf(request.baseUrl) ?? { kind: "ok" };
      if (script.kind === "reject") {
        return errAsync(clientError(script.code, script.message, script.retryable));
      }
      if (script.kind === "hang") {
        // Accepted and never answered: the caller's deadline aborts the wait
        // and the request comes back cancelled, exactly as a timed-out HTTP
        // call does. A hang that outlives its own script is the same non-answer.
        //
        // The wait is deliberately chunked rather than one long timer. The
        // scheduler explores late timer firings (`pickTimerBiasedEarliest`),
        // and a single timer minutes beyond the scenario's own horizon lets
        // that exploration teleport virtual time past *every* deadline in the
        // simulation at once — a jump no stalled HTTP call can cause, which
        // failed `pending-message-blocks-liveness` in ~1 schedule in 10 with
        // the restart correctly issued, only 10 modeled minutes too late
        // (2026-08-10). Short steps keep the non-answer and drop the jump.
        const wait = async (): Promise<void> => {
          const until = task.monotonicNow() + script.durationMs;
          while (task.monotonicNow() < until) {
            const remaining = until - task.monotonicNow();
            await task.sleep(Math.min(remaining, HANG_STEP_MS), "scripted delivery hang", {
              signal: context.signal,
            });
          }
        };
        return ResultAsync.fromPromise(wait(), () =>
          clientError("cancelled", "deliver message: cancelled", true),
        ).andThen(() => errAsync(clientError("cancelled", "deliver message: no answer", true)));
      }
      const state = this.world.resolveRuntime(request.baseUrl, task);
      if (state === null) return errAsync(clientError("unreachable", "no runtime", true));
      const orbId = state.host?.orbId ?? "";
      if (script.kind === "crash_before_enqueue") {
        // The request reached the runtime; nothing of it survives.
        this.world.crashRuntimeBeforeEnqueue(task, orbId);
        return errAsync(
          clientError("unreachable", "deliver message: runtime died before enqueue", true),
        );
      }
      const text = request.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const response = this.world.deliverInboxBatch(
        orbId,
        { batchId: request.messageId, messageIds: request.messageIds, text },
        { flush: script.kind !== "enqueue_without_persist" },
      );
      if (script.kind === "persist_without_ack") {
        // Durable in the session, and the answer never arrives: the control
        // plane must learn about this delivery from replication alone.
        return errAsync(clientError("cancelled", "deliver message: answer lost", true));
      }
      return okAsync(response);
    });
  }

  health(
    task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError> {
    return this.req(task, FAILPOINTS.runtimeHealth, "health", context, () => {
      const state = this.world.resolveRuntime(baseUrl, task);
      if (state === null) return errAsync(clientError("unreachable", "no runtime", true));
      return okAsync(this.world.runtimeHealth(task, state));
    });
  }

  pullHistory(
    task: SimulationTask,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError> {
    return this.req(task, FAILPOINTS.runtimePull, "pull history", context, () => {
      const state = this.world.resolveRuntime(request.baseUrl, task);
      if (state === null) return errAsync(clientError("unreachable", "no runtime", true));
      const health = this.world.runtimeHealth(task, state);
      if (health.status !== "ready") {
        return errAsync(clientError("history_unavailable", "runtime not ready", true));
      }
      if (state.pullOutageUntil > task.monotonicNow()) {
        return errAsync(clientError("history_unavailable", "scripted outage", true));
      }
      const host = state.host;
      if (host === null || host.runtime === null) {
        return errAsync(clientError("unreachable", "no runtime", true));
      }
      const fs = state.filesystem;
      if (fs.header === null) {
        return errAsync(clientError("history_unavailable", "no session", true));
      }
      // Synchronous snapshot of persisted entries.
      const entries = [...fs.entries];
      let startIndex = 0;
      if (request.after !== null) {
        const index = entries.findIndex((record) => record.id === request.after);
        if (index === -1) {
          return errAsync(
            clientError("cursor_not_found", `unknown cursor ${request.after}`, false),
          );
        }
        startIndex = index + 1;
      }
      const records = entries.slice(startIndex, startIndex + request.limit);
      const cursor = records.at(-1)?.id ?? request.after;
      const lastReturnedIndex = startIndex + records.length - 1;
      // headId must be represented by the returned prefix.
      const headIndex = fs.headId === null ? -1 : entries.findIndex((r) => r.id === fs.headId);
      const headId =
        headIndex !== -1 && headIndex <= lastReturnedIndex
          ? fs.headId
          : (records.at(-1)?.id ?? request.after);
      return okAsync<PullHistoryResponse, RuntimeClientError>({
        v: 1,
        orbId: state.reportOrbId ?? host.orbId,
        runtimeInstanceId: host.runtime.instanceId,
        activity: host.runtime.activity,
        session: fs.header,
        records,
        cursor,
        headId,
      });
    });
  }
}

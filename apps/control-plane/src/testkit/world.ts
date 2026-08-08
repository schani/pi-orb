import type {
  HarnessSessionMetadata,
  HistoryRecord,
  PullHistoryResponse,
  RuntimeHealth,
  RuntimeTurnResume,
} from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { OrbHostProviderError, RuntimeClientError } from "../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  OrbRuntimeClient,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
  PullHistoryClientRequest,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

export type InitOutcome = "ready" | "failed_nonretryable" | "failed_retryable" | "never_ready";

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
}

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
}

interface FakeHost {
  ref: OrbHostRef;
  orbId: string;
  state: OrbHostState;
  runtime: FakeRuntimeInstance | null;
  /**
   * The script generation stamped on the host, as the GCE provider stamps
   * `pi-orb-script-generation` (docs/host-provider.md). Every host carries
   * one; the single-provider harness stamps 0 everywhere and never repairs.
   */
  scriptGeneration: number;
  /** Per-incarnation runtime token "carried in the host's env". */
  runtimeToken: string;
  /** Monotonic ms of a hypervisor ACPI soft-off in progress, or null. */
  preemptedAtMonotonic: number | null;
  /** How long a preempted host keeps observing `running` before `stopped`. */
  preemptionSoftWindowMs: number;
}

/** The deterministic stand-in for SHA-256 used by the fake provider. */
export function fakeTokenHash(token: string): string {
  return `sha256(${token})`;
}

/** One completed script repair: the host's stamp moved `from` → `to`. */
export interface ScriptRepair {
  readonly orbId: string;
  readonly from: number;
  readonly to: number;
}

interface OrbWorldState {
  config: Required<FakeOrbConfig>;
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
  /** Provider stop/start operations applied to this orb's host. */
  hostStopCount: number;
  hostStartCount: number;
  /** Every completed script repair of this orb's host, in order. */
  scriptRepairs: ScriptRepair[];
}

/** Measured GCE figure: ~60–70s from `instances.start` to a serving container. */
const DEFAULT_BOOT_LATENCY_MS = 65_000;

/** The soft-off window a preempted Spot VM still observes as `running`. */
const DEFAULT_PREEMPTION_SOFT_WINDOW_MS = 30_000;

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

const DEFAULT_CONFIG: Required<FakeOrbConfig> = {
  initDurationMs: 2_000,
  initOutcome: "ready",
  checkoutCommit: "commit-0",
  containerNeverStarts: false,
  bootLatencyMs: DEFAULT_BOOT_LATENCY_MS,
};

/**
 * A deterministic world of orb hosts, runtimes, and persistent filesystems.
 * Tests drive it (append records, kill runtimes, corrupt sessions) while the
 * fake provider/client below expose it through the domain ports.
 */
export class FakeWorld {
  private readonly orbs = new Map<string, OrbWorldState>();
  private refCounter = 0;

  configureOrb(orbId: string, config: FakeOrbConfig = {}): void {
    this.orbs.set(orbId, {
      config: { ...DEFAULT_CONFIG, ...config },
      filesystem: {
        sessionId: null,
        header: null,
        entries: [],
        headId: null,
        turnInFlight: false,
      },
      host: null,
      runtimeInstanceCounter: 0,
      sessionCounter: 0,
      pullOutageUntil: 0,
      runtimeUnreachableUntil: 0,
      reportOrbId: null,
      hostStopCount: 0,
      hostStartCount: 0,
      scriptRepairs: [],
    });
  }

  private orbState(orbId: string): OrbWorldState {
    const state = this.orbs.get(orbId);
    if (state === undefined) throw new Error(`orb ${orbId} not configured in FakeWorld`);
    return state;
  }

  // -- test drivers ---------------------------------------------------------

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

  provisionHost(
    task: SimulationTask,
    orbId: string,
    scriptGeneration: number = 0,
  ): ProvisionedOrbHost {
    const state = this.orbState(orbId);
    if (state.host !== null) {
      // Idempotent: return the existing host (starting it if stopped) and
      // read its token back — never re-mint for an existing incarnation. A
      // reused host keeps the generation it was stamped with; only a repair
      // (`completeScriptRepair`) restamps it.
      if (state.host.state === "stopped" || state.host.state === "failed") {
        this.startHost(task, state.host.ref);
      }
      return { ref: state.host.ref, runtimeTokenHash: fakeTokenHash(state.host.runtimeToken) };
    }
    this.refCounter += 1;
    const ref: OrbHostRef = { provider: "fake", resourceId: `host-${orbId}-${this.refCounter}` };
    const runtimeToken = `token-${orbId}-${this.refCounter}`;
    state.host = {
      ref,
      orbId,
      state: "running",
      runtime: null,
      runtimeToken,
      scriptGeneration,
      preemptedAtMonotonic: null,
      preemptionSoftWindowMs: DEFAULT_PREEMPTION_SOFT_WINDOW_MS,
    };
    state.hostStartCount += 1;
    this.bootRuntime(task, orbId);
    return { ref, runtimeTokenHash: fakeTokenHash(runtimeToken) };
  }

  /** The orb's host reference, or null when it has none. */
  hostRefOf(orbId: string): OrbHostRef | null {
    return this.orbState(orbId).host?.ref ?? null;
  }

  /** The script generation stamped on the orb's host. */
  scriptGenerationOf(orbId: string): number | null {
    return this.orbState(orbId).host?.scriptGeneration ?? null;
  }

  /** Every completed script repair of the orb's host, oldest first. */
  scriptRepairsOf(orbId: string): readonly ScriptRepair[] {
    return this.orbState(orbId).scriptRepairs;
  }

  /**
   * The fencing rule, in one place: a repair only ever moves a host's stamp
   * *forward*. An older revision meeting a newer host's script leaves it
   * alone; an equal generation repairs nothing, because the stamp already
   * says the host carries this revision's script (the real adapter compares
   * script hashes at equal generation — the fake has no script text, so the
   * generation is the whole comparison).
   */
  private repairIsNeeded(stamped: number, generation: number): boolean {
    return stamped < generation;
  }

  /** Whether `generation` would repair the host behind `ref` right now. */
  needsScriptRepair(ref: OrbHostRef, generation: number): boolean {
    const host = this.findByRef(ref)?.host;
    if (host === null || host === undefined) return false;
    return this.repairIsNeeded(host.scriptGeneration, generation);
  }

  /**
   * The second half of a repair: restamp and start. Re-checks the fence, so a
   * repair whose stop half raced another revision's repair cannot write the
   * stamp backward, and only a repair that actually moved the stamp counts.
   */
  completeScriptRepair(task: SimulationTask, ref: OrbHostRef, generation: number): void {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return;
    const host = state.host;
    if (this.repairIsNeeded(host.scriptGeneration, generation)) {
      state.scriptRepairs.push({ orbId: host.orbId, from: host.scriptGeneration, to: generation });
      host.scriptGeneration = generation;
    }
    this.startHost(task, ref);
  }

  /** The host vanishes entirely (manual removal, definitive absence). */
  removeHost(orbId: string): void {
    this.orbState(orbId).host = null;
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
    const initializing: RuntimeHealth = {
      v: 1,
      orbId,
      runtimeInstanceId: runtime.instanceId,
      status: "initializing",
      phase: "loading_session",
    };
    if (elapsed < state.config.initDurationMs) return initializing;
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
        const fs = state.filesystem;
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
        };
      }
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

/**
 * How long a script repair holds the host stopped between its stop and its
 * restamp+start, standing in for the GCE stop operation plus `setMetadata`.
 * It has to be long enough for another reconciler to *observe* the stopped
 * host — that window is what turned dueling repairs into a war on 2026-08-06
 * (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md) — and
 * short enough to fit inside a provider operation deadline.
 */
const SCRIPT_REPAIR_STOP_MS = 2_000;

export class FakeOrbHostProvider implements OrbHostProvider {
  readonly kind = "fake";
  private readonly world: FakeWorld;
  private readonly maxLatencyMs: number;
  private readonly scriptGeneration: number;

  constructor(world: FakeWorld, maxLatencyMs: number = 50, scriptGeneration: number = 0) {
    this.world = world;
    this.maxLatencyMs = maxLatencyMs;
    this.scriptGeneration = scriptGeneration;
  }

  /**
   * The fake's mirror of `GceOrbHostProvider.ensureCurrentScript`: before
   * provisioning-by-reuse or starting a host, bring its stamped script
   * generation up to this provider's — stop, wait, restamp, start — and let
   * the host pay a full boot again. Fenced forward-only in the world, so a
   * revision never repairs a host stamped by a newer one. Returns whether it
   * repaired (and therefore already started the host).
   */
  private async repairScriptIfNeeded(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): Promise<boolean> {
    if (!this.world.needsScriptRepair(ref, this.scriptGeneration)) return false;
    this.world.stopHost(ref);
    await task.sleep(SCRIPT_REPAIR_STOP_MS, "script repair", { signal: context.signal });
    this.world.completeScriptRepair(task, ref, this.scriptGeneration);
    return true;
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
      // Reuse repairs the script first, exactly as the GCE provider does, so
      // the start below finds an already-running host.
      const existing = this.world.hostRefOf(request.orbId);
      if (existing !== null) await this.repairScriptIfNeeded(task, existing, context);
      return this.world.provisionHost(task, request.orbId, this.scriptGeneration);
    });
  }

  start(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "start", FAILPOINTS.providerStart, context, async () => {
      // A repair has already started the host (GceOrbHostProvider.start).
      if (await this.repairScriptIfNeeded(task, ref, context)) return;
      this.world.startHost(task, ref);
    });
  }

  stop(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "stop", FAILPOINTS.providerStop, context, () => this.world.stopHost(ref));
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

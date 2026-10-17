import {
  type CodemodeExecuteOptions,
  type CodemodeOutcome,
  type CodemodeResult,
  type CodemodeRun,
  type CodemodeRunOptions,
  CodemodeSandbox,
  type CodemodeSandboxOptions,
  loadQuickJSWasm,
} from "@earendil-works/pi-codemode";
import type { SimulationTask } from "determined";
import { Result } from "neverthrow";
import { logOrbEvent } from "../../../domain/log.ts";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_REPLY_BYTES,
  OUTPUT_LIMIT_MESSAGE,
} from "./callback-limits.js";
import { type CodeModeMemory, codeModeMemory } from "./codemode-memory.ts";
import { type CpuBudget, codeModeCpuBudget } from "./cpu-budget.js";

interface Options
  extends Pick<
    CodemodeSandboxOptions,
    "wasm" | "tools" | "globals" | "timeoutMs" | "acquireWorker" | "onWorkerStarted"
  > {
  running?: Set<CodemodeSandbox>;
  orb?: { id: string; task: SimulationTask };
  orbId?: string;
  execution?: { conversationId: string; callId: string };
  cpuBudget?: CpuBudget;
  memory?: CodeModeMemory;
  onResult?(result: CodemodeResult, resources: CodemodeResources): void;
}
interface ExecutionRecord {
  sandbox: CodemodeSandbox;
  signal: AbortSignal;
  abort: AbortController;
  limit(): void;
  cpuStats: SharedArrayBuffer;
  complete(result: CodemodeResult): CodemodeResult;
  dispose(): void;
  snapshot(): CodemodeResources;
}
type ResourceFailure = "callback_limit" | "output_limit" | "out_of_memory" | "sandbox_exit";

export interface CodemodeResources {
  cpu: { budgetCores: number; cpuMs: number; throttledMs: number; checkpoints: number };
  memory: { peakBytes: number };
  callbackLimit: boolean;
  failure?: ResourceFailure;
}

function failure(result: CodemodeResult): CodemodeResources["failure"] {
  if (result.ok) return undefined;
  if (result.error.message === CALLBACK_LIMIT_MESSAGE) return "callback_limit";
  if (result.error.message === OUTPUT_LIMIT_MESSAGE) return "output_limit";
  if (result.error.kind === "script")
    return result.error.name === "InternalError" && result.error.message === "out of memory"
      ? "out_of_memory"
      : undefined;
  if (result.error.kind === "sandbox")
    return result.error.message.includes("out of memory") ? "out_of_memory" : "sandbox_exit";
  return undefined;
}

/** Resource policy around native execution; seed, clock, fingerprint and replay stay upstream. */
export class PiCodemodeSandbox extends CodemodeSandbox {
  private readonly policy: Options;
  private readonly executions = new Set<ExecutionRecord>();
  private readonly exits = new Set<Promise<void>>();
  private readonly launches = new Set<Promise<void>>();
  private stopping = false;

  constructor(options: Options = {}) {
    super({
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.globals ? { globals: options.globals } : {}),
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    this.policy = options;
  }

  private open(signal?: AbortSignal): ExecutionRecord {
    const cpu = (this.policy.cpuBudget ?? codeModeCpuBudget).acquire();
    const memory = (this.policy.memory ?? codeModeMemory).acquire(
      this.policy.orb?.id ?? this.policy.orbId,
    );
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const preAborted = combined.aborted;
    let admitted = false;
    let ended = false;
    let released = false;
    let callbackLimit = false;
    let releaseAdmission: (() => void) | undefined;
    let outcome: CodemodeResult | undefined;
    let finishLaunch!: () => void;
    const launch = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    this.launches.add(launch);
    void launch.then(() => {
      this.launches.delete(launch);
    });
    const wasm = Promise.resolve().then(() => this.policy.wasm ?? loadQuickJSWasm());
    void wasm.catch(() => finishLaunch());
    const release = () => {
      if (released) return;
      released = true;
      cpu.release();
      memory.release();
      this.policy.running?.delete(sandbox);
      if (releaseAdmission) Result.fromThrowable(releaseAdmission, () => undefined)();
    };
    const limit = () => {
      callbackLimit = true;
      abort.abort(new Error(CALLBACK_LIMIT_MESSAGE));
    };
    const sandbox = new CodemodeSandbox({
      tools: this.tools,
      globals: this.globals,
      ...(this.policy.timeoutMs === undefined ? {} : { timeoutMs: this.policy.timeoutMs }),
      memoryLimitBytes: 256 * 1024 * 1024,
      workerUrl: new URL("./bounded-worker.js", import.meta.url),
      workerData: { ...cpu.workerData, ...memory.workerData },
      wasm,
      acquireWorker: () => {
        finishLaunch();
        if (this.stopping || ended || combined.aborted) {
          // biome-ignore lint/plugin/no-throw: native worker admission denies by throwing
          throw new Error("Code-mode worker admission stopped");
        }
        releaseAdmission = this.policy.acquireWorker?.();
        admitted = true;
        return release;
      },
      onWorkerStarted: (exited) => {
        this.exits.add(exited);
        void exited.then(() => {
          this.exits.delete(exited);
        });
        this.policy.onWorkerStarted?.(exited);
      },
    });
    const close = sandbox.close.bind(sandbox);
    sandbox.close = () => {
      abort.abort();
      return close();
    };
    this.policy.running?.add(sandbox);
    if (this.stopping) abort.abort();
    const record = {
      sandbox,
      signal: combined,
      abort,
      limit,
      cpuStats: cpu.workerData.cpuStats,
      complete: (result: CodemodeResult): CodemodeResult => {
        ended = true;
        if (!admitted) release();
        if (preAborted) finishLaunch();
        // A policy abort is terminal, not the restartable "host closed" native outcome.
        outcome = callbackLimit
          ? {
              ok: false,
              error: { kind: "sandbox", message: CALLBACK_LIMIT_MESSAGE },
              output: result.output,
              calls: result.calls,
              ...(result.during ? { during: result.during } : {}),
            }
          : result;
        abort.abort();
        const resources = record.snapshot();
        if (resources.failure && this.policy.orb)
          logOrbEvent(this.policy.orb.task, this.policy.orb.id, "codemode.resource_failed", {
            kind: resources.failure,
            peak_mib: Math.round(resources.memory.peakBytes / 1024 / 1024),
            ...(this.policy.execution
              ? {
                  conversation: this.policy.execution.conversationId,
                  call: this.policy.execution.callId,
                }
              : {}),
          });
        this.policy.onResult?.(outcome, resources);
        return outcome;
      },
      dispose: () => {
        ended = true;
        abort.abort();
        finishLaunch();
        if (!admitted) release();
      },
      snapshot: (): CodemodeResources => {
        const resourceFailure = outcome === undefined ? undefined : failure(outcome);
        return {
          cpu: cpu.snapshot(),
          memory: { peakBytes: memory.peakBytes() },
          callbackLimit: callbackLimit || resourceFailure === "callback_limit",
          ...(resourceFailure === undefined ? {} : { failure: resourceFailure }),
        };
      },
    };
    this.executions.add(record);
    return record;
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    if (this.stopping) {
      // biome-ignore lint/plugin/no-throw: native start rejects a closed sandbox synchronously
      throw new Error("Sandbox is closed");
    }
    const record = this.open(options.signal);
    const started = Result.fromThrowable(
      () =>
        record.sandbox.start(code, {
          ...options,
          signal: record.signal,
          onCall: (call) => {
            if (!record.signal.aborted) options.onCall(call);
          },
        }),
      (error) => error,
    )();
    if (started.isErr()) {
      record.dispose();
      // biome-ignore lint/plugin/no-throw: preserve native start validation contract
      throw started.error;
    }
    const run = started.value;
    let replyBytes = 0;
    return {
      result: run.result.then(record.complete),
      get finished() {
        return run.finished;
      },
      deliver: (seq, now, id, outcome) => {
        if (run.finished || record.signal.aborted) return;
        // Native deliver is a throwing serialization boundary. Snapshot once so getters cannot
        // change the bounded value between accounting and the native JSON round trip.
        const encoded = Result.fromThrowable(
          () =>
            outcome.ok
              ? { payload: outcome.value === undefined ? undefined : JSON.stringify(outcome.value) }
              : {
                  payload: outcome.message,
                  properties:
                    outcome.properties === undefined
                      ? undefined
                      : JSON.stringify(outcome.properties),
                },
          (error) => error,
        )();
        if (encoded.isErr()) {
          // biome-ignore lint/plugin/no-throw: preserve native deliver's serialization error contract
          throw encoded.error;
        }
        replyBytes +=
          Buffer.byteLength(encoded.value.payload ?? "", "utf8") +
          Buffer.byteLength(encoded.value.properties ?? "", "utf8");
        if (replyBytes > MAX_CALLBACK_REPLY_BYTES) {
          record.limit();
          return;
        }
        const snapshot: CodemodeOutcome = outcome.ok
          ? {
              ok: true,
              value:
                encoded.value.payload === undefined ? undefined : JSON.parse(encoded.value.payload),
            }
          : {
              ok: false,
              message: outcome.message,
              ...(encoded.value.properties === undefined
                ? {}
                : { properties: JSON.parse(encoded.value.properties) }),
            };
        run.deliver(seq, now, id, snapshot);
      },
    };
  }

  override execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
    if (this.stopping) {
      // Native execute rejects a closed sandbox.
      return Promise.reject(new Error("Sandbox is closed"));
    }
    const record = this.open(options.signal);
    const started = Result.fromThrowable(
      () => record.sandbox.execute(code, { ...options, signal: record.signal }),
      (error) => error,
    )();
    if (started.isErr()) {
      record.dispose();
      return Promise.reject(started.error);
    }
    return started.value.then(record.complete);
  }

  snapshot(): CodemodeResources {
    const total: CodemodeResources = {
      cpu: { budgetCores: 1, cpuMs: 0, throttledMs: 0, checkpoints: 0 },
      memory: { peakBytes: 0 },
      callbackLimit: false,
    };
    for (const record of this.executions) {
      const item = record.snapshot();
      total.cpu.cpuMs += item.cpu.cpuMs;
      total.cpu.throttledMs += item.cpu.throttledMs;
      total.cpu.checkpoints += item.cpu.checkpoints;
      total.memory.peakBytes = Math.max(total.memory.peakBytes, item.memory.peakBytes);
      total.callbackLimit ||= item.callbackLimit;
      if (item.failure !== undefined) total.failure ??= item.failure;
    }
    return total;
  }

  workerStats(): { cpuStats: SharedArrayBuffer }[] {
    return [...this.executions].map(({ cpuStats }) => ({ cpuStats }));
  }

  override async close(): Promise<void> {
    this.stopping = true;
    for (const record of this.executions) record.abort.abort();
    await Promise.all([...this.executions].map((record) => record.sandbox.close()));
    await super.close();
  }

  async drained(): Promise<void> {
    while (this.launches.size || this.exits.size)
      await Promise.all([...this.launches, ...this.exits]);
  }
}

export function createNativeCodemodeSandbox(options: Options = {}): PiCodemodeSandbox {
  return new PiCodemodeSandbox(options);
}

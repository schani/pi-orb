import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import upstreamSubagents from "@gotgenes/pi-subagents/extension";
import { Result } from "neverthrow";
import type { SubagentError, SubagentRun } from "../../domain/subagent-work.ts";

export interface SubagentHost {
  admitSubagent(childId: string, description?: string): Result<SubagentRun, SubagentError>;
  startSubagent(run: SubagentRun): void;
  abortOperation(): PromiseLike<Result<void, { message: string }>>;
  releaseSubagent(run: SubagentRun): void;
  mayWakeSubagent(childId: string): boolean;
  bindSubagentAbort(abort: () => Result<void, SubagentError>): void;
  subagentAdapterFailed(message: string): void;
}

/** Public events and the fork's delivery hook; no private manager or promise access. */
export function createSubagentsExtension(
  host: SubagentHost,
  cwd: string,
  childExtensions: InlineExtension[] = [],
): ExtensionFactory {
  return (pi) => {
    const runs = new Map<string, SubagentRun>();
    const terminal = new Set<SubagentRun>();
    let shutdown: Promise<void> | undefined;
    let drained: (() => void) | undefined;
    const unsubscribers: (() => void)[] = [];
    const toError = (error: unknown): SubagentError => ({
      type: "subagent_adapter_error",
      message: String(error),
    });
    const record = (phase: string, run: SubagentRun, description?: string): void => {
      const saved = Result.fromThrowable(
        () =>
          pi.appendEntry("pi-orb.subagent-run", {
            ...run,
            phase,
            ...(description !== undefined ? { description } : {}),
          }),
        toError,
      )();
      if (saved.isErr()) host.subagentAdapterFailed(saved.error.message);
    };
    const abort = (id: string): void => {
      const stopped = Result.fromThrowable(() => getSubagentsService()?.abort(id), toError)();
      if (stopped.isErr()) host.subagentAdapterFailed(stopped.error.message);
    };
    for (const event of ["created", "started", "resuming", "completed", "failed", "resumed"]) {
      unsubscribers.push(
        pi.events.on(`subagents:${event}`, (data: unknown) => {
          if (
            typeof data !== "object" ||
            data === null ||
            !("id" in data) ||
            typeof data.id !== "string"
          ) {
            host.subagentAdapterFailed(`Invalid subagents:${event} identity`);
            return;
          }
          const id = data.id;
          if (event === "created" || event === "started" || event === "resuming") {
            const existing = runs.get(id);
            if (event === "started" && existing !== undefined) {
              record("started", existing);
              host.startSubagent(existing);
              return;
            }
            const description =
              "description" in data && typeof data.description === "string" ? data.description : id;
            const admitted = host.admitSubagent(id, description);
            if (admitted.isErr()) {
              abort(id);
              return;
            }
            runs.set(id, admitted.value);
            record("admitted", admitted.value, description);
            if (event !== "created") host.startSubagent(admitted.value);
            return;
          }
          const run = runs.get(id);
          if (run === undefined || terminal.has(run)) return;
          terminal.add(run);
          // The real-package contract pins synchronous append + wake scheduling
          // after this callback. Retain ownership through that exact handoff.
          queueMicrotask(() => {
            record("terminal", run);
            terminal.delete(run);
            if (runs.get(id) === run) runs.delete(id);
            host.releaseSubagent(run);
            if (runs.size === 0) drained?.();
          });
        }),
      );
    }
    // Run before upstream teardown clears its registry and before we remove
    // observers. Its dispose awaits extension hooks, not active tool cleanup.
    pi.on("session_shutdown", () => {
      shutdown ??= (async () => {
        const cancelled = await host.abortOperation();
        if (cancelled.isErr()) host.subagentAdapterFailed(cancelled.error.message);
        if (runs.size > 0)
          await new Promise<void>((resolve) => {
            drained = resolve;
          });
      })();
      return shutdown;
    });
    upstreamSubagents(pi, {
      cwd,
      childExtensions,
      shouldWake: ({ id }) => host.mayWakeSubagent(id),
    });
    pi.on("session_start", () => {
      const service = getSubagentsService();
      if (service === undefined) {
        host.subagentAdapterFailed("Subagent service did not initialize");
        return;
      }
      host.bindSubagentAbort(() =>
        Result.fromThrowable(() => {
          // Snapshot before abort: queued cancellation emits terminal events synchronously.
          for (const id of [...runs.keys()]) service.abort(id);
        }, toError)(),
      );
    });
    pi.on("tool_call", (event) => {
      // The package refuses active resumes by status, but status becomes stopped
      // before cleanup drains. Do not resume that same session during cleanup.
      if (
        event.toolName === "subagent" &&
        typeof event.input["resume"] === "string" &&
        runs.has(event.input["resume"])
      )
        return { block: true, reason: "The subagent's previous execution is still draining" };
      return undefined;
    });
    pi.on("session_shutdown", () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    });
  };
}

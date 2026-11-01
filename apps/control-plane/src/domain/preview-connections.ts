import type { PreviewError } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { sleepResult } from "./dst.ts";
import { logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps } from "./ports.ts";
import {
  PREVIEW_REVALIDATE_MS,
  PREVIEW_VALIDATION_TIMEOUT_MS,
  type PreviewRoute,
  previewError,
  revalidatePreview,
} from "./preview.ts";

export type PreviewWatchRunner = (
  orbId: string,
  operation: (task: SimulationTask) => Promise<void>,
) => ResultAsync<void, PreviewError>;
export interface PreviewConnection {
  activity(): void;
  release(task: SimulationTask): Promise<void>;
}
interface Owned {
  readonly id: string;
  readonly route: PreviewRoute;
  readonly http: boolean;
  readonly cancel: (error: PreviewError) => void;
  activity: number;
  validatedActivity: number;
}
export class PreviewConnections {
  private readonly owned = new Map<string, Map<string, Owned>>();
  private readonly watching = new Set<string>();
  private count = 0;
  private nextId = 0;
  private readonly deps: ControlPlaneDeps;
  private readonly run: PreviewWatchRunner;
  constructor(deps: ControlPlaneDeps, run: PreviewWatchRunner) {
    this.deps = deps;
    this.run = run;
  }
  add(
    task: SimulationTask,
    route: PreviewRoute,
    http: boolean,
    cancel: (error: PreviewError) => void,
  ): Result<PreviewConnection, PreviewError> {
    const orbId = route.target.orbId;
    const existing = this.owned.get(orbId) ?? new Map<string, Owned>();
    if (this.count >= 128 || existing.size >= 16)
      return err(previewError("capacity_exceeded", "Preview stream limit reached"));
    const id = `preview-${++this.nextId}`;
    const owned: Owned = { id, route, http, cancel, activity: 0, validatedActivity: 0 };
    existing.set(id, owned);
    this.owned.set(orbId, existing);
    this.count++;
    this.deps.control.registerLifecycleConnection(orbId, id, () =>
      this.terminate(task, owned, previewError("orb_unavailable", "Orb admission closed")),
    );
    this.startWatch(task, orbId);
    return ok({
      activity: () => {
        owned.activity++;
      },
      release: async (releaseTask) => {
        if (!this.detach(owned)) return;
        if (owned.http || owned.activity > 0)
          await this.deps.store.touchLastBusy(releaseTask, { orbId, now: releaseTask.wallNow() });
      },
    });
  }
  close(task: SimulationTask): void {
    for (const entries of [...this.owned.values()])
      for (const owned of [...entries.values()])
        this.terminate(task, owned, previewError("cancelled", "Preview gateway shut down"));
  }
  private detach(owned: Owned): boolean {
    const orbId = owned.route.target.orbId;
    const entries = this.owned.get(orbId);
    if (!entries?.delete(owned.id)) return false;
    this.count--;
    this.deps.control.unregisterLifecycleConnection(orbId, owned.id);
    if (entries.size === 0) this.owned.delete(orbId);
    return true;
  }
  private terminate(task: SimulationTask, owned: Owned, error: PreviewError): void {
    if (!this.detach(owned)) return;
    owned.cancel(error);
    if (
      this.deps.control.noteCondition(
        `preview-blocker:${owned.route.target.orbId}:${owned.route.target.port}`,
        true,
      )
    )
      logOrbEvent(task, owned.route.target.orbId, "preview-streams-terminated", {
        port: owned.route.target.port,
        reason: error.code,
        incarnation: owned.route.target.incarnation,
      });
  }
  private startWatch(task: SimulationTask, orbId: string): void {
    if (this.watching.has(orbId)) return;
    this.watching.add(orbId);
    void this.run(orbId, (watchTask) => this.watch(watchTask, orbId)).then((result) => {
      this.watching.delete(orbId);
      if (result.isErr()) {
        for (const owned of [...(this.owned.get(orbId)?.values() ?? [])])
          this.terminate(task, owned, result.error);
      }
      if ((this.owned.get(orbId)?.size ?? 0) > 0) this.startWatch(task, orbId);
    });
  }
  private async watch(task: SimulationTask, orbId: string): Promise<void> {
    while ((this.owned.get(orbId)?.size ?? 0) > 0) {
      const slept = await sleepResult(
        task,
        PREVIEW_REVALIDATE_MS,
        "preview authority revalidation",
      );
      if (slept.isErr()) {
        for (const owned of [...(this.owned.get(orbId)?.values() ?? [])])
          this.terminate(task, owned, previewError("cancelled", "Preview watcher cancelled"));
        return;
      }
      const entries = [...(this.owned.get(orbId)?.values() ?? [])];
      if (entries.length === 0) return;
      const deadline = task.createDeadline(
        PREVIEW_VALIDATION_TIMEOUT_MS,
        "preview authority deadline",
      );
      let expire: () => void = () => {};
      const expired = new Promise<Result<void, PreviewError>>((resolve) => {
        expire = () =>
          resolve(err(previewError("deadline_exceeded", "Preview authority validation timed out")));
        deadline.signal.addEventListener("abort", expire, { once: true });
      });
      const results = new Map<string, Result<void, PreviewError>>();
      for (const owned of entries) {
        if (!this.owned.get(orbId)?.has(owned.id)) continue;
        const key = `${owned.route.target.port}:${owned.route.target.registrationId}:${owned.route.target.runtimeInstanceId}`;
        const activity = entries.some(
          (candidate) =>
            candidate.route.target.port === owned.route.target.port &&
            (candidate.http || candidate.activity !== candidate.validatedActivity),
        );
        let result = results.get(key);
        if (result === undefined && deadline.signal.aborted)
          result = err(previewError("deadline_exceeded", "Preview authority validation timed out"));
        if (result === undefined) {
          result = await Promise.race([
            revalidatePreview(task, this.deps, owned.route, activity, deadline.signal),
            expired,
          ]);
          results.set(key, result);
        }
        if (task.wallNow() >= owned.route.expiresAt)
          result = err(previewError("unauthenticated", "Preview session expired"));
        if (result.isErr()) this.terminate(task, owned, result.error);
        else {
          owned.validatedActivity = owned.activity;
          if (
            this.deps.control.noteCondition(
              `preview-blocker:${orbId}:${owned.route.target.port}`,
              false,
            )
          )
            logOrbEvent(task, orbId, "preview-admission-recovered", {
              port: owned.route.target.port,
            });
        }
      }
      deadline.signal.removeEventListener("abort", expire);
      deadline.cancel();
    }
  }
}

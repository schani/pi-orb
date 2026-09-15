import type {
  AgentSettings,
  AgentSettingsEvent,
  ModelOption,
  SettingsAction,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";

export interface SettingsError {
  readonly type: "settings_error";
  readonly message: string;
  readonly unchanged?: boolean;
}
interface Options {
  task: Pick<SimulationTask, "checkpoint" | "withTimedSignal">;
  timeoutMs?: number;
  onFailure?: (error: SettingsError) => void;
  initial: AgentSettings;
  models: ModelOption[];
  isIdle: () => boolean;
  apply: (action: SettingsAction) => PromiseLike<Result<AgentSettings, SettingsError>>;
  publish: (view: AgentSettingsEvent) => void;
}
/** Short configuration ownership, shared with all agent input admission. No turn or retry queue. */
export class AgentSettingsController {
  private pending = false;
  private failed = false;
  private current: AgentSettings;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.current = options.initial;
  }
  get blocksInput(): boolean {
    return this.pending || this.failed;
  }
  get view(): AgentSettingsEvent {
    return {
      type: "agent_settings",
      settings: this.current,
      models: this.options.models,
      writable: !this.blocksInput,
    };
  }
  /** Supported SDK-originated changes use the same full-state publication; never expose an in-flight setter. */
  invalidate(error: SettingsError): void {
    this.failed = true;
    this.options.onFailure?.(error);
    this.options.publish(this.view);
  }
  observe(settings: AgentSettings): void {
    if (this.blocksInput || JSON.stringify(settings) === JSON.stringify(this.current)) return;
    this.current = settings;
    this.options.publish(this.view);
  }
  change(
    action: SettingsAction,
  ): ResultAsync<void, { code: "busy" | "invalid_request" | "internal"; message: string }> {
    if (this.blocksInput || !this.options.isIdle())
      return ResultAsync.fromSafePromise(
        Promise.resolve(
          err({ code: "busy" as const, message: "Wait for the current operation to finish." }),
        ),
      ).andThen((result) => result);
    const target = action.type === "set_model" ? action.model : this.current.model;
    const model = this.options.models.find(
      (item) => item.provider === target.provider && item.id === target.id,
    );
    if (
      !model ||
      (action.type === "set_thinking" && !model.thinkingLevels.includes(action.thinkingLevel))
    )
      return ResultAsync.fromSafePromise(
        Promise.resolve(
          err({
            code: "invalid_request" as const,
            message: "That setting is not available for this model.",
          }),
        ),
      ).andThen((result) => result);
    if (
      (action.type === "set_model" &&
        target.provider === this.current.model.provider &&
        target.id === this.current.model.id) ||
      (action.type === "set_thinking" && action.thinkingLevel === this.current.thinkingLevel)
    )
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    this.pending = true;
    this.options.publish(this.view);
    return ResultAsync.fromSafePromise(this.run(action)).andThen((result) => result);
  }
  private async run(
    action: SettingsAction,
  ): Promise<Result<void, { code: "internal"; message: string }>> {
    await this.options.task.checkpoint("settings claimed before SDK");
    const applied = await this.options.task.withTimedSignal(
      (signal) =>
        new Promise<Result<AgentSettings, SettingsError>>((resolve) => {
          const cancelled = () =>
            resolve(
              err({
                type: "settings_error",
                message: "Settings change timed out; runtime recovery is required.",
              }),
            );
          signal.addEventListener("abort", cancelled, { once: true });
          if (signal.aborted) {
            cancelled();
            return;
          }
          void Promise.resolve(this.options.apply(action)).then((result) => {
            signal.removeEventListener("abort", cancelled);
            resolve(result);
          });
        }),
      this.options.timeoutMs ?? 15_000,
      "agent settings apply",
    );
    if (applied.isErr()) {
      this.failed = applied.error.unchanged !== true;
      this.pending = false;
      if (this.failed) this.options.onFailure?.(applied.error);
      this.options.publish(this.view);
      return err({ code: "internal", message: applied.error.message });
    }
    this.current = applied.value;
    this.pending = false;
    this.options.publish(this.view);
    return ok(undefined);
  }
}

import { ok, type Result } from "neverthrow";
import type { IdleStopFence, IdleStopFenceError } from "../pi/idle-stop-fence.ts";

export class MemoryIdleStopFence implements IdleStopFence {
  private lifetime: string | null = null;
  read(): Result<string | null, IdleStopFenceError> {
    return ok(this.lifetime);
  }
  write(lifetime: string): Result<void, IdleStopFenceError> {
    this.lifetime = lifetime;
    return ok(undefined);
  }
}

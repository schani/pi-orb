import type { StreamAudit, StreamTelemetry } from "./stream-telemetry.ts";

/** Scheduling is injectable; each poll and shutdown fence is one synchronous transition. */
export class StreamMonitor {
  private cancel: (() => void) | null = null;
  private stopped = false;
  private readonly telemetry: StreamTelemetry;
  private readonly audit: (edge: StreamAudit) => void;
  private readonly schedule: (tick: () => void) => () => void;
  constructor(
    telemetry: StreamTelemetry,
    audit: (edge: StreamAudit) => void,
    schedule: (tick: () => void) => () => void,
  ) {
    this.telemetry = telemetry;
    this.audit = audit;
    this.schedule = schedule;
  }
  start(): void {
    if (this.cancel !== null || this.stopped) return;
    this.cancel = this.schedule(() => {
      if (this.stopped) return;
      for (const edge of this.telemetry.poll()) this.audit(edge);
    });
  }
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }
}

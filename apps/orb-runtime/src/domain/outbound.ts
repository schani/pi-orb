import type { ServerFrame } from "@pi-orb/protocol";

/** Minimal socket surface the writer needs; adapted over `ws` in production. */
export interface FrameSink {
  send(json: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface OutboundWriterOptions {
  /** Budget for queued critical post-sync frames; overflow closes the connection. */
  readonly maxCriticalBufferedBytes: number;
  /** Socket buffered-amount level above which frames queue in the writer. */
  readonly highWaterMark: number;
}

export const OUTBOUND_CLOSE_CODE_BACKPRESSURE = 1013;

const encoder = new TextEncoder();

function isTransient(frame: ServerFrame): boolean {
  if (frame.type !== "runtime.event") return false;
  const kind = frame.event.type;
  return kind === "output_patch" || kind === "tool_state" || kind === "status";
}

/**
 * Per-connection ordered outbound writer (DESIGN.md §6.2/§6.4).
 *
 * The synchronization batch bypasses the budget entirely: it references
 * entries the harness already holds in memory, and closing on its size would
 * only recreate the same oversized batch on the next attempt. Post-sync
 * frames queue under backpressure; transient events coalesce to their newest
 * equivalent state, critical frames are never dropped, and a critical-frame
 * budget overflow closes the connection so the browser reconstructs state
 * through a new handshake.
 */
export class OutboundWriter {
  private readonly sink: FrameSink;
  private readonly options: OutboundWriterOptions;
  private readonly queue: { frame: ServerFrame; bytes: number }[] = [];
  private closed = false;

  constructor(sink: FrameSink, options: OutboundWriterOptions) {
    this.sink = sink;
    this.options = options;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send the §6.2 synchronization batch immediately; exempt from the budget. */
  enqueueSyncBatch(frames: readonly ServerFrame[]): void {
    if (this.closed) return;
    for (const frame of frames) {
      this.sink.send(JSON.stringify(frame));
    }
  }

  enqueue(frame: ServerFrame): void {
    if (this.closed) return;
    if (this.queue.length === 0 && this.sink.bufferedAmount < this.options.highWaterMark) {
      this.sink.send(JSON.stringify(frame));
      return;
    }
    if (isTransient(frame) && this.tryCoalesce(frame)) {
      this.checkBudget();
      return;
    }
    const bytes = encoder.encode(JSON.stringify(frame)).length;
    this.queue.push({ frame, bytes });
    this.checkBudget();
  }

  /** Called when the underlying socket reports that its buffer drained. */
  onDrain(): void {
    if (this.closed) return;
    while (this.queue.length > 0 && this.sink.bufferedAmount < this.options.highWaterMark) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.sink.send(JSON.stringify(next.frame));
    }
  }

  private tryCoalesce(frame: ServerFrame): boolean {
    if (frame.type !== "runtime.event") return false;
    const event = frame.event;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const queued = this.queue[i];
      if (queued === undefined || queued.frame.type !== "runtime.event") continue;
      const queuedEvent = queued.frame.event;
      if (event.type === "status" && queuedEvent.type === "status") {
        this.replaceAt(i, frame);
        return true;
      }
      if (
        event.type === "output_patch" &&
        queuedEvent.type === "output_patch" &&
        event.operationId === queuedEvent.operationId &&
        event.blockId === queuedEvent.blockId
      ) {
        if (event.patch.type === "replace") {
          this.replaceAt(i, frame);
        } else if (queuedEvent.patch.type === "append") {
          this.replaceAt(i, {
            ...frame,
            event: {
              ...event,
              patch: { type: "append", text: queuedEvent.patch.text + event.patch.text },
            },
          });
        } else {
          // Queued replace + new append: fold into one replace.
          this.replaceAt(i, {
            ...frame,
            event: {
              ...event,
              patch: { type: "replace", text: queuedEvent.patch.text + event.patch.text },
            },
          });
        }
        return true;
      }
      if (
        event.type === "tool_state" &&
        queuedEvent.type === "tool_state" &&
        event.operationId === queuedEvent.operationId &&
        event.callId === queuedEvent.callId
      ) {
        this.replaceAt(i, frame);
        return true;
      }
    }
    return false;
  }

  private replaceAt(index: number, frame: ServerFrame): void {
    const bytes = encoder.encode(JSON.stringify(frame)).length;
    this.queue[index] = { frame, bytes };
  }

  private checkBudget(): void {
    let criticalBytes = 0;
    for (const queued of this.queue) {
      if (!isTransient(queued.frame)) criticalBytes += queued.bytes;
    }
    if (criticalBytes > this.options.maxCriticalBufferedBytes) {
      this.closed = true;
      this.queue.length = 0;
      this.sink.close(OUTBOUND_CLOSE_CODE_BACKPRESSURE, "outbound budget exceeded");
    }
  }
}

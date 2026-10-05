export interface ActivityHeadlineSource {
  recordId: string;
  detailKey: string;
  headline: string | null;
}
type Marker = { detailKey: string; headline?: string | null };

export function selectToolHeadline(
  call: Marker,
  callRecordId: string,
  result?: Marker,
  resultRecordId?: string,
): ActivityHeadlineSource | undefined {
  if (result && resultRecordId && Object.hasOwn(result, "headline")) {
    return result.headline === undefined
      ? undefined
      : {
          recordId: resultRecordId,
          detailKey: result.detailKey,
          headline: result.headline,
        };
  }
  return call.headline === undefined
    ? undefined
    : {
        recordId: callRecordId,
        detailKey: call.detailKey,
        headline: call.headline,
      };
}

/** Each mounted view owns two HTTP slots, separate from detail loading. */
export class HeadlineLimiter {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  enqueue(start: (release: () => void) => void): () => void {
    this.queue.push(start);
    this.drain();
    return () => {
      const index = this.queue.indexOf(start);
      if (index !== -1) this.queue.splice(index, 1);
    };
  }

  private drain(): void {
    while (this.active < 2 && this.queue.length > 0) {
      const start = this.queue.shift();
      if (!start) break;
      this.active += 1;
      let released = false;
      start(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}

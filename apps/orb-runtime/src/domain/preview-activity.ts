export interface PreviewLease {
  touch(): void;
  release(): void;
}
export class PreviewActivity {
  private activeHttp = 0;
  private lastApplicationData = -Infinity;
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }
  acquire(kind: "http" | "websocket"): PreviewLease {
    let released = false;
    if (kind === "http") this.activeHttp++;
    this.lastApplicationData = this.now();
    return {
      touch: () => {
        if (!released) this.lastApplicationData = this.now();
      },
      release: () => {
        if (released) return;
        released = true;
        if (kind === "http") this.activeHttp--;
      },
    };
  }
  blocksIdle(): boolean {
    return this.activeHttp > 0 || this.now() - this.lastApplicationData <= 15_000;
  }
}

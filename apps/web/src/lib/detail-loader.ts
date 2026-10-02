import type { Result } from "neverthrow";

/** One open disclosure. Every open/close/disconnect advances the response owner. */
export class DetailLoader<T, E = string> {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private key: string | undefined;
  private running = false;
  private online = true;
  private readonly pending: Map<string, Promise<Result<T, E>>>;

  private readonly options: {
    read: (key: string) => Promise<Result<T, E>>;
    publish: (result: Result<T, E>) => void;
    intervalMs?: number;
    shouldContinue?: (value: T) => boolean;
    pending?: Map<string, Promise<Result<T, E>>>;
  };

  constructor(options: {
    read: (key: string) => Promise<Result<T, E>>;
    publish: (result: Result<T, E>) => void;
    intervalMs?: number;
    shouldContinue?: (value: T) => boolean;
    pending?: Map<string, Promise<Result<T, E>>>;
  }) {
    this.options = options;
    this.pending = options.pending ?? new Map();
  }

  open(key: string, running: boolean): void {
    this.close();
    this.key = key;
    this.running = running;
    if (this.online) this.refresh(this.generation);
  }

  connected(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.generation++;
    this.stopTimer();
    if (online && this.key !== undefined) this.refresh(this.generation);
  }

  close(): void {
    this.generation++;
    this.stopTimer();
    this.key = undefined;
  }

  retry(): void {
    this.stopTimer();
    this.refresh(this.generation);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private refresh(owner: number): void {
    const key = this.key;
    if (key === undefined || !this.online) return;
    let request = this.pending.get(key);
    if (request === undefined) {
      request = this.options.read(key);
      this.pending.set(key, request);
      void request.then(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    }
    void request.then((result) => {
      if (this.generation !== owner || this.key !== key || !this.online) return;
      this.options.publish(result);
      if (this.running && result.isOk() && (this.options.shouldContinue?.(result.value) ?? true)) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.refresh(owner);
        }, this.options.intervalMs ?? 1000);
      }
    });
  }
}

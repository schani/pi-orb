export type SessionExpiryScheduler = (delayMs: number, callback: () => void) => () => void;

const scheduleExpiry: SessionExpiryScheduler = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Owns one socket's deadline; admission also checks time when a timer is delayed. */
export function watchSessionExpiry(
  expiresAt: number | undefined,
  now: () => number,
  expire: () => void,
  schedule: SessionExpiryScheduler = scheduleExpiry,
): { admit(): boolean; stop(): void } {
  let stopped = false;
  let cancel = (): void => undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancel();
  };
  const admit = (): boolean => {
    if (stopped) return false;
    if (expiresAt !== undefined && now() >= expiresAt) {
      stop();
      expire();
      return false;
    }
    return true;
  };
  const arm = (): void => {
    if (!admit() || expiresAt === undefined) return;
    cancel = schedule(Math.max(0, expiresAt - now()), arm);
  };
  arm();
  return { admit, stop };
}

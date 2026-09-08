interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function installAbortSignalHandlers(
  controller: AbortController,
  source: SignalSource = process,
): void {
  let interrupted = false;
  const abortOnce = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
  };
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) source.on(signal, abortOnce);
}

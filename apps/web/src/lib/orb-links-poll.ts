type Visibility = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly visibilityState: string;
};

/** One visible-tab request at a time; cleanup aborts and discards late completions. */
export function pollVisible<T>(
  read: (signal: AbortSignal) => Promise<T>,
  receive: (value: T) => void,
  document: Visibility,
): () => void {
  const controller = new AbortController();
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const poll = async () => {
    clear();
    if (controller.signal.aborted || pending || document.visibilityState !== "visible") return;
    pending = true;
    const value = await read(controller.signal);
    pending = false;
    if (controller.signal.aborted) return;
    receive(value);
    if (document.visibilityState === "visible") timer = setTimeout(poll, 15_000);
  };
  const visible = () => {
    clear();
    if (document.visibilityState === "visible") void poll();
  };
  document.addEventListener("visibilitychange", visible);
  void poll();
  return () => {
    controller.abort();
    clear();
    document.removeEventListener("visibilitychange", visible);
  };
}

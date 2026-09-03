export type BrowserSessionState =
  | { status: "active" }
  | { status: "auth_required"; detectedAt: number };

let state: BrowserSessionState = { status: "active" };
let requestSequence = 0;
let lastAuthFailureSequence = 0;
let lastApplicationReachedSequence = 0;
const listeners = new Set<() => void>();

function publish(next: BrowserSessionState): void {
  if (next.status === state.status) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Gives concurrent responses a monotonic order for session-state updates. */
export function beginSessionRequest(): number {
  requestSequence += 1;
  return requestSequence;
}

export function reportAuthenticationRequired(sequence: number): void {
  if (sequence < lastAuthFailureSequence || sequence < lastApplicationReachedSequence) return;
  lastAuthFailureSequence = sequence;
  publish({ status: "auth_required", detectedAt: Date.now() });
}

/**
 * Any non-401 response proves that this request reached the application behind
 * IAP. Only a request begun after the latest 401 may restore the session, so a
 * late response from older concurrent work cannot erase an auth failure.
 */
export function reportApplicationReached(sequence: number): void {
  lastApplicationReachedSequence = Math.max(lastApplicationReachedSequence, sequence);
  if (state.status === "auth_required" && sequence <= lastAuthFailureSequence) return;
  publish({ status: "active" });
}

export function readBrowserSession(): BrowserSessionState {
  return state;
}

export function subscribeToBrowserSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetBrowserSessionForTest(): void {
  state = { status: "active" };
  requestSequence = 0;
  lastAuthFailureSequence = 0;
  lastApplicationReachedSequence = 0;
  for (const listener of listeners) listener();
}

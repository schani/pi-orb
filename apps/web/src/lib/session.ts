import { devConsoleDebug } from "./dev-console-debug.ts";

export type BrowserSessionState =
  | { status: "active" }
  | { status: "auth_required"; detectedAt: number };

let state: BrowserSessionState = { status: "active" };
let requestSequence = 0;
let principal: string | null = null;
let logoutAvailable = false;
export const readLogoutAvailable = (): boolean => logoutAvailable;
let generation = 0;
let lastPrincipalSequence = 0;

export const readSessionPrincipal = (): string | null => principal;
export const readSessionGeneration = (): number => generation;

export function reportSessionPrincipal(sequence: number, next: string, canLogout = false): void {
  if (sequence < lastPrincipalSequence || sequence <= lastAuthFailureSequence) return;
  lastPrincipalSequence = sequence;
  const changed = principal !== next || logoutAvailable !== canLogout;
  logoutAvailable = canLogout;
  if (principal !== next) {
    principal = next;
    generation += 1;
    devConsoleDebug.clear();
  }
  if (changed) for (const listener of listeners) listener();
  reportApplicationReached(sequence);
}

export function reportLoggedOut(): void {
  principal = null;
  logoutAvailable = false;
  generation += 1;
  devConsoleDebug.clear();
  lastAuthFailureSequence = beginSessionRequest();
  state = { status: "auth_required", detectedAt: Date.now() };
  for (const listener of listeners) listener();
}
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

/** Only a validated session probe may restore authentication. */
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
  principal = null;
  logoutAvailable = false;
  generation = 0;
  lastPrincipalSequence = 0;
  lastAuthFailureSequence = 0;
  lastApplicationReachedSequence = 0;
  for (const listener of listeners) listener();
}

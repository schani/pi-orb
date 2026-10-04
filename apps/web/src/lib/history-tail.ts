const HISTORY_BATCH_ROWS = 20;
const HISTORY_TOP_THRESHOLD = 160;

export function initialTailIndex(count: number): number {
  return Math.max(0, count - HISTORY_BATCH_ROWS);
}

export function retainedTailIndex(keys: readonly string[], first: string | null): number {
  const index = first === null ? -1 : keys.indexOf(first);
  return index < 0 ? initialTailIndex(keys.length) : index;
}

export function upwardRevealIndex(first: number, scrollTop: number, upward: boolean): number {
  return upward && scrollTop <= HISTORY_TOP_THRESHOLD
    ? Math.max(0, first - HISTORY_BATCH_ROWS)
    : first;
}

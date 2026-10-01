export function latestEntryAlertId(
  records: readonly { id: string; type: string; alert?: { message: string } }[],
  unreadAlertId: string | null | undefined,
): string | null {
  if (unreadAlertId && !records.some((record) => record.id === unreadAlertId)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record?.type === "event" && record.alert !== undefined) return record.id;
  }
  return null;
}

export function shouldAcknowledgeSelection(
  currentOrbId: string,
  selectedOrbId: string,
  activation: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  visible: boolean,
): boolean {
  return (
    visible &&
    currentOrbId === selectedOrbId &&
    activation.button === 0 &&
    !activation.metaKey &&
    !activation.ctrlKey &&
    !activation.shiftKey &&
    !activation.altKey
  );
}

export function acceptAlertMetadata(requestRevision: number, currentRevision: number): boolean {
  return requestRevision === currentRevision;
}

export interface AlertEntry {
  recordId: string | null;
}

/** Capture the identity at selection; subsequent updates cannot change this entry. */
export function beginAlertEntry(
  unreadAlertId: string | null | undefined,
  latestVisibleAlertId: string | null,
): AlertEntry {
  return { recordId: latestVisibleAlertId ?? unreadAlertId ?? null };
}

/** A reply about A must not overwrite metadata already reporting B. */
export function resolveAlertAck(
  entry: AlertEntry,
  currentUnreadAlertId: string | null,
  replyUnreadAlertId: string | null,
  error: string | null = null,
): { unreadAlertId: string | null; error: string | null } {
  if (error !== null) return { unreadAlertId: currentUnreadAlertId, error };
  return {
    unreadAlertId:
      currentUnreadAlertId !== entry.recordId && currentUnreadAlertId !== null
        ? currentUnreadAlertId
        : replyUnreadAlertId,
    error: null,
  };
}

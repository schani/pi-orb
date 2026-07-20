interface ComposerProps {
  text: string;
  onTextChange: (text: string) => void;
  /** Connected, idle, and no request in flight. */
  canSend: boolean;
  onSend: () => void;
  /** An operation is running and can be aborted. */
  canAbort: boolean;
  onAbort: () => void;
  /** A request is awaiting its result frame. */
  pending: boolean;
}

export function Composer({
  text,
  onTextChange,
  canSend,
  onSend,
  canAbort,
  onAbort,
  pending,
}: ComposerProps) {
  const sendEnabled = canSend && text.trim() !== "";
  return (
    <div className="composer">
      <textarea
        className="composer-input"
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        placeholder="Message the agent…"
        rows={3}
        disabled={!canSend}
      />
      <div className="composer-actions">
        <button type="button" onClick={onSend} disabled={!sendEnabled}>
          {pending ? "sending…" : "send"}
        </button>
        {canAbort && (
          <button type="button" className="danger" onClick={onAbort}>
            abort
          </button>
        )}
      </div>
    </div>
  );
}

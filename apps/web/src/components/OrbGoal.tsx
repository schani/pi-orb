import type { ClientAction, GoalView, HarnessKind } from "@pi-orb/protocol";
import {
  type Ref,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isSendShortcut } from "./send-shortcut.ts";
import { TextFieldFrame } from "./TextFieldFrame.tsx";
import "./OrbGoal.css";

export type GoalAction = Extract<
  ClientAction,
  { type: "goal_set" | "goal_pause" | "goal_resume" | "goal_clear" }
>;
type Opener = "add" | "command";

export interface OrbGoalHandle {
  open: (from: Opener) => void;
}

export function OrbGoal({
  ref,
  goal,
  harness,
  writable,
  pending,
  error,
  onChange,
  onClose,
}: {
  ref?: Ref<OrbGoalHandle>;
  goal: GoalView | null;
  harness: HarnessKind | undefined;
  writable: boolean;
  pending: boolean;
  error: string | null;
  onChange: (action: GoalAction) => void;
  onClose: (from: Opener) => void;
}) {
  const [editor, setEditor] = useState<Opener | null>(null);
  const [objective, setObjective] = useState("");
  const objectiveId = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const toEditor = useCallback((node: HTMLTextAreaElement | null) => {
    input.current = node;
    node?.focus({ preventScroll: true });
  }, []);

  useImperativeHandle(ref, () => ({
    open: (from) => {
      if (disclosure.current !== null) {
        disclosure.current.open = true;
        summary.current?.focus({ preventScroll: true });
      } else if (writable) {
        setEditor(from);
        input.current?.focus({ preventScroll: true });
      }
    },
  }));

  useLayoutEffect(() => {
    const focused = lastFocus.current;
    if (focused !== null && !focused.isConnected) {
      lastFocus.current = null;
      if (document.activeElement === document.body) {
        if (summary.current) summary.current.focus({ preventScroll: true });
        else if (writable) onClose(editor ?? "add");
      }
    }
    if (goal !== null && editor !== null) {
      setEditor(null);
      setObjective("");
    }
  }, [goal, editor, writable, onClose]);

  const closeEditor = () => {
    setEditor(null);
    setObjective("");
    onClose(editor ?? "add");
  };
  const submit = (action: GoalAction) => {
    if (writable && !pending) onChange(action);
  };
  const objectiveText = objective.trim();
  const canSet = writable && !pending && objectiveText !== "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Tracks focus within the native disclosure and editor.
    <div
      data-goal-controls
      onFocus={(event) => {
        if (event.target instanceof HTMLElement) lastFocus.current = event.target;
      }}
      onBlur={(event) => {
        if (event.target.isConnected && !event.currentTarget.contains(event.relatedTarget))
          lastFocus.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !disclosure.current?.open)
          return;
        event.preventDefault();
        event.stopPropagation();
        disclosure.current.open = false;
        summary.current?.focus({ preventScroll: true });
      }}
    >
      {goal !== null ? (
        <details ref={disclosure} className="orb-goal activity-rail-row" data-status={goal.status}>
          <summary ref={summary} aria-label={`Goal: ${goal.objective} · ${goal.status}`}>
            <span className="activity-rail-marker" aria-hidden="true" />
            <strong className="activity-rail-summary">{goal.objective}</strong>
            <em className="goal-status" aria-live="polite">
              {goal.status}
            </em>
          </summary>
          {(goal.reason || writable) && (
            <div className="goal-body">
              {goal.reason && <p className="goal-reason">{goal.reason}</p>}
              {writable && (
                <div className="goal-actions">
                  {harness !== "claude" && goal.status !== "complete" && (
                    <button
                      type="button"
                      className="text-action"
                      aria-disabled={pending}
                      onClick={() =>
                        submit({
                          type: goal.status === "active" ? "goal_pause" : "goal_resume",
                          revision: goal.revision,
                        })
                      }
                      title={goal.status === "active" ? "Pause future automatic turns" : undefined}
                    >
                      {goal.status === "active" ? "Pause" : "Resume"}
                    </button>
                  )}
                  {(harness === "claude" || goal.status !== "active") && (
                    <button
                      type="button"
                      className="text-action danger"
                      aria-disabled={pending}
                      onClick={() => submit({ type: "goal_clear", revision: goal.revision })}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </details>
      ) : editor !== null ? (
        <form
          className="goal-editor"
          aria-label="New goal"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSet) submit({ type: "goal_set", objective: objectiveText });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              closeEditor();
            }
          }}
        >
          <label htmlFor={objectiveId}>Objective</label>
          <TextFieldFrame>
            <textarea
              id={objectiveId}
              ref={toEditor}
              rows={2}
              required
              readOnly={!writable || pending}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || !isSendShortcut(event)) return;
                event.preventDefault();
                if (canSet && !event.repeat) event.currentTarget.form?.requestSubmit();
              }}
            />
          </TextFieldFrame>
          <div className="goal-actions">
            <button type="submit" className="text-action" aria-disabled={!canSet}>
              Set goal
            </button>
            <button type="button" className="text-action" onClick={closeEditor}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {error !== null && (
        <p className="goal-error error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

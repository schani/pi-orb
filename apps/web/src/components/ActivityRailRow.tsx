import { createContext, type ReactNode, type Ref, useContext } from "react";

/** Opens every row rendered directly beneath it; nested rows are unaffected. */
export const ActivityRailOpen = createContext(false);
export const ActivityRailHidden = createContext(false);

interface ActivityRailRowProps {
  label: ReactNode;
  headerRef?: Ref<HTMLElement>;
  headline?: ReactNode;
  strip?: ReactNode;
  metric?: ReactNode;
  state?: "neutral" | "running" | "completed" | "failed";
  className?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
}

/**
 * The single structural primitive for every activity row in an Orb turn.
 * Keeping marker, columns, spacing, and disclosure behavior here prevents
 * reasoning and tool categories from drifting apart visually.
 */
export function ActivityRailRow({
  label,
  headerRef,
  headline,
  strip,
  metric,
  state = "neutral",
  className = "",
  children,
  defaultOpen = false,
  onToggle,
}: ActivityRailRowProps) {
  const forcedOpen = useContext(ActivityRailOpen);
  const hidden = useContext(ActivityRailHidden);
  return (
    <details
      className={`activity-rail-row activity-rail-row-${state} ${className}`.trim()}
      open={defaultOpen || forcedOpen || undefined}
      hidden={hidden || undefined}
      onToggle={onToggle === undefined ? undefined : (event) => onToggle(event.currentTarget.open)}
    >
      <summary ref={headerRef}>
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">
          <span className="activity-rail-label">{label}</span>
          {strip}
          {headline !== undefined && (
            <>
              {" · "}
              <span
                className="activity-rail-headline"
                title={typeof headline === "string" ? headline : undefined}
              >
                {headline}
              </span>
            </>
          )}
        </span>
        {metric !== undefined && <span className="activity-rail-metric">{metric}</span>}
      </summary>
      <ActivityRailOpen value={false}>{children}</ActivityRailOpen>
    </details>
  );
}

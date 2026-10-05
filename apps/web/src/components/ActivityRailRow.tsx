import type { ReactNode, Ref } from "react";

interface ActivityRailRowProps {
  label: string;
  headerRef?: Ref<HTMLElement>;
  headline?: ReactNode;
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
  metric,
  state = "neutral",
  className = "",
  children,
  defaultOpen = false,
  onToggle,
}: ActivityRailRowProps) {
  return (
    <details
      className={`activity-rail-row activity-rail-row-${state} ${className}`.trim()}
      open={defaultOpen || undefined}
      onToggle={onToggle === undefined ? undefined : (event) => onToggle(event.currentTarget.open)}
    >
      <summary ref={headerRef}>
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">
          <span className="activity-rail-label">{label}</span>
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
      {children}
    </details>
  );
}

import type { ReactNode } from "react";

interface ActivityRailRowProps {
  label: string;
  headline?: ReactNode;
  metric?: ReactNode;
  state?: "neutral" | "running" | "completed" | "failed";
  className?: string;
  children?: ReactNode;
}

/**
 * The single structural primitive for every activity row in an Orb turn.
 * Keeping marker, columns, spacing, and disclosure behavior here prevents
 * reasoning and tool categories from drifting apart visually.
 */
export function ActivityRailRow({
  label,
  headline,
  metric,
  state = "neutral",
  className = "",
  children,
}: ActivityRailRowProps) {
  return (
    <details className={`activity-rail-row activity-rail-row-${state} ${className}`.trim()}>
      <summary>
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

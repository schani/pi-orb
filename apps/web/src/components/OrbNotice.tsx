import type { ReactNode } from "react";

/** A lifecycle, auth, or error diagnostic, on the transcript's system prefix. */
export function OrbNotice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return (
    <div className="rec rec-sys">
      <span className="rec-px">···</span>
      <div className={error ? "rec-bd notice notice-error" : "rec-bd notice"}>{children}</div>
    </div>
  );
}

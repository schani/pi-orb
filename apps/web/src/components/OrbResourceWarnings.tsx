import type { ResourceWarning } from "@pi-orb/protocol";
import { OrbNotice } from "./OrbNotice.tsx";

const reasons: Record<ResourceWarning["code"], string> = {
  invalid_utf8: "invalid UTF-8",
  invalid_yaml: "invalid YAML",
  invalid_metadata: "invalid skill metadata",
  duplicate_name: "duplicate skill name",
};

export function OrbResourceWarnings({
  warnings,
}: {
  warnings?: readonly ResourceWarning[] | undefined;
}) {
  if (!warnings?.length) return null;
  return (
    <OrbNotice>
      {warnings.map((warning) => (
        <div key={`${warning.path}:${warning.code}`}>
          Skipped repository skill {warning.path}: {reasons[warning.code]}.
        </div>
      ))}
    </OrbNotice>
  );
}

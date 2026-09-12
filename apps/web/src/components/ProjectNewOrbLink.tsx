import type { MouseEventHandler } from "react";
import { Icon } from "./Icons.tsx";

export function ProjectNewOrbLink({
  projectId,
  disabled,
  iconLabel,
  onClick,
}: {
  projectId: string;
  disabled: boolean;
  iconLabel?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const className =
    iconLabel === undefined ? "project-new-orb" : "icon-button project-new-orb-icon";
  const content = iconLabel === undefined ? "new orb" : <Icon name="plus" />;
  return disabled ? (
    <button type="button" className={className} aria-label={iconLabel} title={iconLabel} disabled>
      {content}
    </button>
  ) : (
    <a
      className={className}
      href={`#/projects/${projectId}/orbs/new`}
      aria-label={iconLabel}
      title={iconLabel}
      onClick={onClick}
    >
      {content}
    </a>
  );
}

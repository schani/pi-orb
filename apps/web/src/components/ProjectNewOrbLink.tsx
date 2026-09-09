export function ProjectNewOrbLink({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  return disabled ? (
    <button type="button" className="project-new-orb" disabled>
      new orb
    </button>
  ) : (
    <a className="project-new-orb" href={`#/projects/${projectId}/orbs/new`}>
      new orb
    </a>
  );
}

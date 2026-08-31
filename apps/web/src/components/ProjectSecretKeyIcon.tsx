interface ProjectSecretKeyIconProps {
  readonly className?: string;
}

export function ProjectSecretKeyIcon({ className }: ProjectSecretKeyIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="12" r="4" />
      <path d="M11 12h10M17 12v3M20 12v2" />
    </svg>
  );
}

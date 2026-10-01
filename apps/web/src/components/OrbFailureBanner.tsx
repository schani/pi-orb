interface OrbFailureBannerProps {
  readonly message?: string | undefined;
}

/** Durable lifecycle failure surfaced by OrbView.lastError. */
export function OrbFailureBanner({ message }: OrbFailureBannerProps) {
  return message === undefined ? null : (
    <div className="rec rec-sys orb-failure-banner">
      <div className="rec-bd notice notice-error">{message}</div>
    </div>
  );
}

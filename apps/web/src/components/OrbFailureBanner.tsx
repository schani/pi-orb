import { OrbNotice } from "./OrbNotice.tsx";

interface OrbFailureBannerProps {
  readonly message?: string | undefined;
}

/** Durable lifecycle failure surfaced by OrbView.lastError. */
export function OrbFailureBanner({ message }: OrbFailureBannerProps) {
  return message === undefined ? null : <OrbNotice error>{message}</OrbNotice>;
}

export const DEFAULT_PAGE_TITLE = "pi-orb";

/** Builds the browser-tab title for a loaded orb, using the same unnamed fallback as the UI. */
export function orbPageTitle(projectName: string, orbName: string | null): string {
  return `${projectName} · ${orbName ?? "untitled orb"}`;
}

interface TitleDocument {
  title: string;
}

export function setPageTitle(title: string, target: TitleDocument = document): void {
  target.title = title;
}

export interface AppSearchItem {
  /** Stable, source-namespaced identity used to retain keyboard selection. */
  key: string;
  kindLabel: string;
  title: string;
  context?: string;
  /** Matching uses only these explicit fields, never presentation labels implicitly. */
  keywords: readonly string[];
  /** Every result is link-native. */
  href: string;
}

export type AppSearchStatus =
  | { type: "complete" }
  | { type: "loading"; message: string }
  | { type: "partial_error"; message: string };

export interface AppSearchSource {
  /** Changing source identity resets query and selection. */
  id: string;
  label: string;
  placeholder: string;
  scopeDescription: string;
  items: readonly AppSearchItem[];
  status: AppSearchStatus;
}

export const APP_SEARCH_RESULT_LIMIT = 50;

export interface AppSearchActivationModifiers {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Only ordinary same-tab activation closes the current card. */
export function shouldCloseAppSearchForActivation(
  activation: AppSearchActivationModifiers,
): boolean {
  return (
    activation.button === 0 &&
    !activation.metaKey &&
    !activation.ctrlKey &&
    !activation.shiftKey &&
    !activation.altKey
  );
}

export function normalizeAppSearchText(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

/** Stable substring matching over only source-declared keywords. */
export function matchAppSearchItems(
  items: readonly AppSearchItem[],
  query: string,
): AppSearchItem[] {
  const normalizedQuery = normalizeAppSearchText(query);
  if (normalizedQuery === "") return [];
  return items.filter((item) =>
    item.keywords.some((keyword) => normalizeAppSearchText(keyword).includes(normalizedQuery)),
  );
}

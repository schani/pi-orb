export interface AppSearchGlyph {
  char: string;
  /** Hue class suffix (`s-<state>`). */
  state: string;
  label: string;
}

export interface AppSearchItem {
  /** Stable, source-namespaced identity used to retain keyboard selection. */
  key: string;
  kindLabel: string;
  /** Uppercase heading the item is listed under; defaults to `kindLabel`. */
  group?: string;
  title: string;
  context?: string;
  glyph?: AppSearchGlyph;
  /** Owning resource, shown as a chip. */
  chip?: string;
  age?: string;
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
  items: readonly AppSearchItem[];
  status: AppSearchStatus;
}

export const APP_SEARCH_RESULT_LIMIT = 50;

export interface AppSearchPointerPosition {
  x: number;
  y: number;
}

/** Browser redraws may dispatch pointer events without physical pointer movement. */
export function didAppSearchPointerMove(
  previous: AppSearchPointerPosition | null,
  next: AppSearchPointerPosition,
): boolean {
  return previous !== null && (previous.x !== next.x || previous.y !== next.y);
}

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

export function selectedAppSearchIndex(
  items: readonly AppSearchItem[],
  activeKey: string | null,
): number {
  const requestedIndex = items.findIndex((item) => item.key === activeKey);
  return requestedIndex < 0 && items.length > 0 ? 0 : requestedIndex;
}

export function moveAppSearchSelection(
  items: readonly AppSearchItem[],
  activeKey: string | null,
  offset: number,
): string | null {
  if (items.length === 0) return null;
  const currentIndex = selectedAppSearchIndex(items, activeKey);
  const nextIndex = (currentIndex + offset + items.length) % items.length;
  return items[nextIndex]?.key ?? null;
}

export function appSearchGroup(item: AppSearchItem): string {
  return item.group ?? item.kindLabel;
}

/** Groups matches under their headings, keeping first-seen group and item order. */
export function orderAppSearchMatches(items: readonly AppSearchItem[]): AppSearchItem[] {
  const groups: string[] = [];
  for (const item of items) {
    const group = appSearchGroup(item);
    if (!groups.includes(group)) groups.push(group);
  }
  return groups.flatMap((group) => items.filter((item) => appSearchGroup(item) === group));
}

/** Stable substring matching over only source-declared keywords. */
export function matchAppSearchItems(
  items: readonly AppSearchItem[],
  query: string,
): AppSearchItem[] {
  const normalizedQuery = normalizeAppSearchText(query);
  if (normalizedQuery === "") return [];
  return orderAppSearchMatches(
    items.filter((item) =>
      item.keywords.some((keyword) => normalizeAppSearchText(keyword).includes(normalizedQuery)),
    ),
  );
}

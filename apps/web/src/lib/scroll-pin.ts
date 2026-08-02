/** How close to the bottom (px) still counts as "following the tail". */
export const PIN_SLACK_PX = 48;

/**
 * Whether the viewport is at (or within slack of) the bottom of the page.
 * Pinned means new chat content should auto-scroll into view; unpinned means
 * the reader scrolled up and their position must not move.
 */
export function isPinnedToBottom(view: {
  scrollY: number;
  viewportHeight: number;
  contentHeight: number;
}): boolean {
  return view.scrollY + view.viewportHeight >= view.contentHeight - PIN_SLACK_PX;
}

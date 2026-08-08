/** How close to the bottom (px) still counts as "following the tail". */
export const PIN_SLACK_PX = 48;

/**
 * Whether the viewport is at (or within slack of) the bottom of the page.
 * Pinned means new chat content should auto-scroll into view; unpinned means
 * the reader scrolled up and their position must not move.
 */
export interface ScrollView {
  scrollY: number;
  viewportHeight: number;
  contentHeight: number;
}

export function isPinnedToBottom(view: ScrollView): boolean {
  return view.scrollY + view.viewportHeight >= view.contentHeight - PIN_SLACK_PX;
}

/**
 * Resolve a scroll event without mistaking a delayed event from our own
 * scrollTo call for the reader scrolling up. The document may have grown
 * again before that event is delivered, making its once-bottom position look
 * unpinned against the newer content height.
 */
export function isPinnedAfterScroll(view: ScrollView, autoScrollY: number | null): boolean {
  const isOwnScroll = autoScrollY !== null && Math.abs(view.scrollY - autoScrollY) <= 1;
  return isOwnScroll || isPinnedToBottom(view);
}

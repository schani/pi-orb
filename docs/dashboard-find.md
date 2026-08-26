# Dashboard Find

> **Status:** Architecture and presentation decided and implemented 2026-08-26. The selected presentation is **Index card**. The five-direction exploration is preserved in `design-prototypes/dashboard-find.html`, and the formatted architecture is in `design-prototypes/dashboard-find-architecture.html`.

## Goal and scope

On the dashboard, Command-K on macOS and Control-K elsewhere opens pi-orb Find. Find searches the dashboard resources a person recognizes:

- project display names;
- project GitHub repository URLs; and
- orb display names, including orbs in the archive shelf.

Find is navigation, not a general command palette. It does not search IDs, lifecycle state, transcript content, checkout files, or agent output. It does not make a network request per keystroke.

The shortcut is dashboard-scoped. Orb, missing-resource, and create-orb routes retain the browser's default Command-K / Control-K behavior. On the dashboard, the shortcut opens Find even when focus is in a creation or rename field; this keeps the dashboard navigation shortcut globally available within its route. Repeating the shortcut focuses and selects the Find query. Escape closes Find and restores focus to the element that was focused before it opened when that element still exists. The card has a visible close control, but the dashboard header has no persistent Find hint or button.

## Reusable client architecture

The app-level mechanism is generic; the dashboard is only its first search source. This avoids baking projects, orbs, GitHub, or dashboard lifecycle into the Command-K listener or Index card.

Three layers have one-way dependencies:

1. **App search shell** — an `AppSearchProvider` mounted once by the application owns the shortcut, open/query/active-key state, focus restoration, and the selected `AppSearchDialog` presentation. It knows only the generic contracts below.
2. **Pure search core** — `apps/web/src/lib/app-search.ts` owns normalization, substring matching, stable source-order filtering, and the 50-row presentation limit. It has no React, route, transport, or resource imports.
3. **Route adapter** — the active route supplies an `AppSearchSource`. The dashboard adapter maps its already-loaded `ProjectView` and `OrbView` state into generic items and status. A future orb page, credentials page, or other surface can provide a different source without modifying the shell or core.

```ts
type AppSearchItem = {
  key: string;                 // stable and source-namespaced
  kindLabel: string;           // e.g. "project" or "orb"
  title: string;
  context?: string;            // e.g. repository URL or parent project
  keywords: readonly string[]; // matching fields; never inferred from rendering
  href: string;                // every result is link-native
};

type AppSearchStatus =
  | { type: "complete" }
  | { type: "loading"; message: string }
  | { type: "partial_error"; message: string };

type AppSearchSource = {
  id: string;                  // changes reset query and selection
  label: string;               // accessible dialog name
  placeholder: string;
  scopeDescription: string;
  items: readonly AppSearchItem[];
  status: AppSearchStatus;
};
```

Routes register at most one active source through a small `useAppSearchSource(source | null)` hook and unregister it on cleanup. The provider intercepts Command-K only when a source is registered; otherwise the browser retains its default. Source replacement closes the card and clears route-specific state, preventing results from one route from leaking into another.

Every item has an `href`, and every result row is a real anchor—never a button with an imperative navigation callback. Ordinary click, Command/Ctrl-click, middle-click, keyboard activation, link preview, copy-link, and the browser context menu therefore behave normally. The dialog closes only for an unmodified same-tab activation; modified activation must leave the current tab untouched.

Orb results use `#/orbs/:orbId`. Project results use the canonical focused-dashboard URL `#/projects/:projectId`. That route renders the ordinary dashboard, scrolls to and focuses the named project once its data loads, and otherwise leaves all dashboard behavior intact. It is a real resource URL: if the project is absent, it stays at that URL and renders “Project doesn't exist” with a link back to `#/`, following the missing-resource rule in `docs/web-ui.md`. This focused route is not a separate project-detail page and requires no new API.

The generic layer is deliberately synchronous and transport-free. A future server-backed search surface owns its request, cancellation, typed errors, and result state in its route adapter, then supplies an ordinary source snapshot. The shell must not grow resource-specific fetching or caching policy.

`ProjectsPage` already owns the complete project list and independently loaded orb lists. Its dashboard adapter derives `AppSearchItem[]` with `useMemo`; it introduces no control-plane API or persistence change. Project names and repository URL aliases become project `keywords`; orb names become orb `keywords`. Dashboard ordering and partial-load status are likewise computed by this adapter.

### Normalization and matching

- Trim the query, Unicode-normalize it with NFKC, and apply locale-independent lowercase.
- Match a contiguous substring. Do not add fuzzy matching in the first version: predictable URL fragments such as `github.com/acme` and exact name fragments matter more than typo tolerance.
- Match only the explicit `keywords` supplied by a source adapter; generic Find never makes labels, context, IDs, or object fields searchable implicitly.
- The dashboard adapter supplies project keywords from the project name, repository URL exactly as returned by the API, and a display-neutral `github.com/owner/repo` alias with protocol and trailing `.git` removed. It does not attempt repository resolution.
- The dashboard adapter supplies orb keywords from the display name only. The fallback label `untitled orb` is searchable when the API name is absent.
- An empty query shows no result list (or the unfiltered dashboard in an in-place-filter treatment), plus concise scope help. It must not rank arbitrary “recent” resources.

The core preserves source item order and never invents relevance ranking. The dashboard adapter emits projects in API order, followed by each project's working orbs and archive orbs in displayed order, so a direct project match precedes that project's orb matches. The Index card renders the first 50 matches while reporting the full match count.

Activating a project result follows `#/projects/:projectId`, where the dashboard scrolls its panel into view, briefly marks it, and puts focus on the project heading. Activating an orb result follows `#/orbs/:orbId`. Because both rows are anchors, Command/Ctrl-click, middle-click, copy-link, link preview, and context-menu open work without special simulation.

## Loading, failures, and mutation

Find indexes only resources successfully loaded into the dashboard state. While any orb list is loading, the surface says `Searching loaded items · some orbs still loading`; the memoized index grows as responses arrive without clearing the query or active selection. A failed orb list stays visibly failed in its project panel and Find says that some orbs could not be searched. It must never claim `No matches` without this qualification.

Project rename, orb auto-naming observed by a dashboard refresh, archival, deletion, and project removal rebuild the derived index. Active selection is identified by stable entry key, not row number; if that key disappears, the first remaining result becomes the effective selection without an intermediate unselected render. Exactly zero or one row carries selected styling: actual pointer movement changes the same active key used by Up/Down, and CSS hover never adds a second visual selection. The dialog remembers the last pointer coordinates and ignores stationary-pointer events caused by result DOM replacement, so a redraw cannot briefly select the row under an unmoving pointer before returning to the keyboard selection. The result region remains mounted while the query changes so one result set is replaced directly by the next without an empty-frame flash. No independent search cache is allowed, so results cannot outlive dashboard truth.

## Keyboard and accessibility contract

- Register one `keydown` listener in `AppSearchProvider` for the application lifetime. When and only when an active source exists, match `(event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k"`, call `preventDefault()`, then open/focus Find.
- Use a real `search` landmark. Overlay treatments use an accessible dialog with `aria-modal="true"`; in-place treatments use an expanded region and do not claim modal behavior.
- The query is `<input type="search">` with an explicit `aria-label`. Announce result count and partial-loading/failure status through one polite live region.
- Up/Down changes the sole active result, actual pointer movement updates that same selection, Enter activates it, and Tab follows ordinary interactive-element order.
- The close control and every result arrow share one fixed-width trailing column and horizontal center. Do not trap focus for nonmodal treatments; modal treatments contain focus until closed.
- Result links include resource kind and parent context in their accessible names. Visual highlights may use `<mark>`, but accessible names remain uninterrupted.
- At narrow widths, preserve a 44px close target, keep the query visible above the on-screen keyboard, and never depend on hover.

## Testing and observability

Pure core unit tests cover normalization, explicit keyword matching, stable source order, and result limits without importing dashboard types. Dashboard-adapter tests separately cover URL aliases, field scope (IDs and states must not match), archived orbs, dashboard order, status mapping, and recomputation after mutation. Provider/dialog component tests cover source registration and cleanup, source-switch reset, no shortcut interception without a source, repeated shortcut focus, Escape focus restoration, keyboard selection, anchor hrefs for every item, native modified-link activation without closing the current card, zero matches, and partial loading/failure copy. The E2E acceptance scenario uses fixtures whose project name, GitHub URL, working-orb name, and archived-orb name each match distinct queries and verifies navigation.

Find makes no autonomous server-side decision and creates no durable state, so lifecycle logging would be noise. User-facing diagnostics are the relevant observability: result count, indexed-item count, and explicit partial loading/failure status are visible in the surface. Development-only component diagnostics may be inspected in React tooling, but product correctness must not depend on console logs.

## Presentation directions

The interactive HTML study compares five treatments while retaining the contract above:

1. **Header lens** — a compact search field unfolds from the dashboard app header.
2. **Index card** — a centered modal with explicit project/orb result rows.
3. **Margin index** — a nonmodal right rail keeps results beside the dashboard.
4. **Filter folio** — Find expands inline and filters/highlights the existing project panels.
5. **Bottom ribbon** — a compact browser-find-inspired bar with previous/next stepping.

The centered **Index card** was selected 2026-08-26. It best communicates cross-project navigation, has enough room for repository and parent context, works at phone widths, and does not rearrange the dashboard while typing. The other four directions remain preserved as rejected presentation alternatives; they share the same indexing architecture but are not implementation targets.

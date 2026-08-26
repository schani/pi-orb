import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  APP_SEARCH_RESULT_LIMIT,
  type AppSearchSource,
  didAppSearchPointerMove,
  matchAppSearchItems,
  moveAppSearchSelection,
  selectedAppSearchIndex,
  shouldCloseAppSearchForActivation,
} from "../lib/app-search.ts";

interface SearchRegistration {
  owner: symbol;
  source: AppSearchSource;
}

interface AppSearchContextValue {
  upsertSource(owner: symbol, source: AppSearchSource): void;
  removeSource(owner: symbol): void;
}

const AppSearchContext = createContext<AppSearchContextValue | null>(null);
const ignoreSourceUpsert = (_owner: symbol, _source: AppSearchSource) => {};
const ignoreSourceRemoval = (_owner: symbol) => {};

/** Registers one route-owned source without coupling the app shell to its resource types. */
export function useAppSearchSource(source: AppSearchSource | null): void {
  const context = useContext(AppSearchContext);
  const upsertSource = context?.upsertSource ?? ignoreSourceUpsert;
  const removeSource = context?.removeSource ?? ignoreSourceRemoval;
  const owner = useRef(Symbol("app-search-source"));

  useEffect(() => {
    if (source === null) removeSource(owner.current);
    else upsertSource(owner.current, source);
  }, [removeSource, source, upsertSource]);

  useEffect(() => () => removeSource(owner.current), [removeSource]);
}

function highlightedText(text: string, query: string): ReactNode {
  const trimmedQuery = query.trim();
  if (trimmedQuery === "") return text;
  const index = text.toLowerCase().indexOf(trimmedQuery.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + trimmedQuery.length)}</mark>
      {text.slice(index + trimmedQuery.length)}
    </>
  );
}

export interface AppSearchDialogProps {
  source: AppSearchSource;
  query: string;
  activeKey: string | null;
  onQueryChange(query: string): void;
  onActiveKeyChange(key: string): void;
  onClose(restoreFocus?: boolean): void;
}

export function AppSearchDialog({
  source,
  query,
  activeKey,
  onQueryChange,
  onActiveKeyChange,
  onClose,
}: AppSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resultRefs = useRef(new Map<string, HTMLAnchorElement>());
  const lastPointerPosition = useRef<{ x: number; y: number } | null>(null);
  const matches = useMemo(() => matchAppSearchItems(source.items, query), [query, source.items]);
  const visibleMatches = matches.slice(0, APP_SEARCH_RESULT_LIMIT);
  const selectedIndex = selectedAppSearchIndex(visibleMatches, activeKey);
  const selectedKey = visibleMatches[selectedIndex]?.key ?? null;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const move = (offset: number) => {
    const nextKey = moveAppSearchSelection(visibleMatches, activeKey, offset);
    if (nextKey !== null) {
      onActiveKeyChange(nextKey);
      resultRefs.current.get(nextKey)?.scrollIntoView({ block: "nearest" });
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      const active = visibleMatches[selectedIndex < 0 ? 0 : selectedIndex];
      if (active !== undefined) {
        event.preventDefault();
        resultRefs.current.get(active.key)?.click();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const containFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("input, a[href], button") ?? [],
    ).filter((element) => !element.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onResultClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (shouldCloseAppSearchForActivation(event)) onClose(false);
  };

  const countText =
    query.trim() === ""
      ? "Type to find"
      : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;

  return (
    <div className="app-search-backdrop">
      <div
        ref={dialogRef}
        className="app-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={source.label}
        onKeyDown={containFocus}
        onPointerLeave={() => {
          lastPointerPosition.current = null;
        }}
      >
        <search className="app-search-query-row">
          <span className="app-search-query-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            className="app-search-input"
            aria-label={source.label}
            aria-activedescendant={
              selectedIndex < 0 ? undefined : `app-search-result-${selectedIndex}`
            }
            autoComplete="off"
            placeholder={source.placeholder}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className="app-search-close"
            aria-label="Close Find"
            onClick={() => onClose()}
          >
            ×
          </button>
        </search>
        <div className="app-search-result-region">
          {query.trim() === "" ? (
            <p className="app-search-empty">{source.scopeDescription}</p>
          ) : visibleMatches.length === 0 ? (
            <p className="app-search-empty">
              No matches{source.status.type === "complete" ? "" : " in loaded items"}
            </p>
          ) : (
            visibleMatches.map((item, index) => (
              <a
                key={item.key}
                id={`app-search-result-${index}`}
                ref={(element) => {
                  if (element === null) resultRefs.current.delete(item.key);
                  else resultRefs.current.set(item.key, element);
                }}
                className={`app-search-result${item.key === selectedKey ? " active" : ""}`}
                href={item.href}
                aria-label={`${item.kindLabel}: ${item.title}${item.context === undefined ? "" : `, ${item.context}`}`}
                onPointerMove={(event) => {
                  const nextPosition = { x: event.clientX, y: event.clientY };
                  const pointerMoved = didAppSearchPointerMove(
                    lastPointerPosition.current,
                    nextPosition,
                  );
                  lastPointerPosition.current = nextPosition;
                  if (pointerMoved) onActiveKeyChange(item.key);
                }}
                onClick={onResultClick}
              >
                <span className="app-search-kind">{item.kindLabel}</span>
                <span className="app-search-result-copy">
                  <span className="app-search-result-title">
                    {highlightedText(item.title, query)}
                  </span>
                  {item.context !== undefined && (
                    <span className="app-search-result-context">
                      {highlightedText(item.context, query)}
                    </span>
                  )}
                </span>
                <span className="app-search-result-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            ))
          )}
        </div>
        <div className="app-search-footer">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="app-search-count" aria-live="polite">
            {countText}
            {source.status.type === "complete" ? "" : ` · ${source.status.message}`}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AppSearchProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<SearchRegistration | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const upsertSource = useCallback((owner: symbol, source: AppSearchSource) => {
    setRegistration((current) => {
      if (current?.owner !== owner || current.source.id !== source.id) {
        setOpen(false);
        setQuery("");
        setActiveKey(null);
      } else {
        setActiveKey((currentKey) =>
          currentKey !== null && source.items.some((item) => item.key === currentKey)
            ? currentKey
            : null,
        );
      }
      return { owner, source };
    });
  }, []);

  const removeSource = useCallback((owner: symbol) => {
    setRegistration((current) => {
      if (current?.owner !== owner) return current;
      setOpen(false);
      setQuery("");
      setActiveKey(null);
      return null;
    });
  }, []);

  const openSearch = useCallback(() => {
    if (registration === null) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, [registration]);

  const closeSearch = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (previousFocus.current?.isConnected === true) previousFocus.current.focus();
      });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        registration !== null &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        openSearch();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSearch, open, openSearch, registration]);

  const context = useMemo<AppSearchContextValue>(
    () => ({ upsertSource, removeSource }),
    [removeSource, upsertSource],
  );

  return (
    <AppSearchContext.Provider value={context}>
      {children}
      {open && registration !== null && (
        <AppSearchDialog
          source={registration.source}
          query={query}
          activeKey={activeKey}
          onQueryChange={(nextQuery) => {
            setQuery(nextQuery);
            setActiveKey(matchAppSearchItems(registration.source.items, nextQuery)[0]?.key ?? null);
          }}
          onActiveKeyChange={setActiveKey}
          onClose={closeSearch}
        />
      )}
    </AppSearchContext.Provider>
  );
}

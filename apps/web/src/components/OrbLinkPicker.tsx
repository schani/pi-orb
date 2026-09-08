import type { ProjectView } from "@pi-orb/protocol";
import { useEffect, useState } from "react";
import { listOrbs, listProjects } from "../lib/api.ts";
import {
  buildDashboardSearchSource,
  type DashboardOrbListSnapshot,
} from "../lib/dashboard-search-source.ts";
import { AppSearchDialog } from "./AppSearch.tsx";

/** A fresh index belongs to this picker opening, never to the global search shell. */
export function OrbLinkPicker({
  onSelect,
  onClose,
}: {
  onSelect(href: string): void;
  onClose(): void;
}) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [orbLists, setOrbLists] = useState<Record<string, DashboardOrbListSnapshot>>({});
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listProjects();
      if (cancelled) return;
      if (result.isErr()) {
        setProjectsFailed(true);
        return;
      }
      setProjects(result.value.items);
      await Promise.all(
        result.value.items.map(async (project) => {
          const orbs = await listOrbs(project.id);
          if (cancelled) return;
          setOrbLists((current) => ({
            ...current,
            [project.id]: orbs.isOk()
              ? { type: "loaded", items: orbs.value.items }
              : { type: "failed" },
          }));
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const source = buildDashboardSearchSource({
    projects: projects ?? [],
    projectsLoading: projects === null && !projectsFailed,
    projectsFailed,
    orbLists,
    now,
  });
  return (
    <AppSearchDialog
      source={{
        ...source,
        id: "orb-link-picker",
        label: "Find orbs",
        items: source.items.filter((item) => item.group === "orbs"),
      }}
      query={query}
      activeKey={activeKey}
      onQueryChange={(value) => {
        setQuery(value);
        setActiveKey(null);
      }}
      onActiveKeyChange={setActiveKey}
      onClose={onClose}
      onSelect={(item) => onSelect(item.href)}
    />
  );
}

import { useState, useSyncExternalStore } from "react";
import { AppSearchProvider } from "./components/AppSearch.tsx";
import { IconSprite } from "./components/Icons.tsx";
import { SessionRibbon } from "./components/SessionRibbon.tsx";
import { readPath, subscribeNavigation } from "./lib/navigation.ts";
import { TranscriptCache } from "./lib/transcript-cache.ts";
import { TranscriptCacheContext } from "./lib/transcript-cache-context.ts";
import { CreateOrbPage } from "./pages/CreateOrbPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OrbPage } from "./pages/OrbPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";

export type Route =
  | { page: "projects"; focusedProjectId: string | null }
  | { page: "create_orb"; projectId: string }
  | { page: "mcp"; projectId: string }
  | { page: "orb"; orbId: string }
  | { page: "not_found" };

export function parseRoute(url: string): Route {
  const path = url.split(/[?#]/, 1)[0] ?? "";
  if (path === "/") return { page: "projects", focusedProjectId: null };
  const id = (value: string): string | null => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const mcpMatch = /^\/projects\/([^/]+)\/mcp$/.exec(path);
  const mcpId = mcpMatch?.[1];
  if (mcpId) {
    const projectId = id(mcpId);
    if (projectId) return { page: "mcp", projectId };
  }
  const createMatch = /^\/projects\/([^/]+)\/orbs\/new$/.exec(path);
  const projectId = createMatch?.[1];
  if (projectId) {
    const decoded = id(projectId);
    if (decoded) return { page: "create_orb", projectId: decoded };
  }
  const focusedProjectMatch = /^\/projects\/([^/]+)$/.exec(path);
  const focusedProjectId = focusedProjectMatch?.[1];
  if (focusedProjectId) {
    const decoded = id(focusedProjectId);
    if (decoded) return { page: "projects", focusedProjectId: decoded };
  }
  const orbMatch = /^\/orbs\/([^/]+)$/.exec(path);
  const orbId = orbMatch?.[1];
  if (orbId) {
    const decoded = id(orbId);
    if (decoded) return { page: "orb", orbId: decoded };
  }
  return { page: "not_found" };
}

function AppRoutes({ cache }: { cache: TranscriptCache }) {
  const path = useSyncExternalStore(subscribeNavigation, readPath);
  const route = parseRoute(path);
  return route.page === "mcp" || route.page === "projects" ? (
    <ProjectsPage
      focusedProjectId={route.page === "mcp" ? route.projectId : route.focusedProjectId}
      mcpConfigOpen={route.page === "mcp"}
    />
  ) : route.page === "create_orb" ? (
    <CreateOrbPage key={route.projectId} projectId={route.projectId} />
  ) : route.page === "orb" ? (
    <OrbPage orbId={route.orbId} cache={cache} />
  ) : (
    <NotFoundPage />
  );
}

export function App() {
  const [cache] = useState(() => new TranscriptCache());
  return (
    <TranscriptCacheContext.Provider value={cache}>
      <AppSearchProvider>
        <div className="app">
          <IconSprite />
          <SessionRibbon />
          <AppRoutes cache={cache} />
        </div>
      </AppSearchProvider>
    </TranscriptCacheContext.Provider>
  );
}

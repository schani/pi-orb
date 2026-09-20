import { useState, useSyncExternalStore } from "react";
import { AppSearchProvider } from "./components/AppSearch.tsx";
import { IconSprite } from "./components/Icons.tsx";
import { SessionRibbon } from "./components/SessionRibbon.tsx";
import { readSessionPrincipal, subscribeToBrowserSession } from "./lib/session.ts";
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

export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/") return { page: "projects", focusedProjectId: null };
  const mcpMatch = /^\/projects\/([^/]+)\/mcp$/.exec(path);
  if (mcpMatch?.[1]) return { page: "mcp", projectId: mcpMatch[1] };
  const createMatch = /^\/projects\/([^/]+)\/orbs\/new$/.exec(path);
  const projectId = createMatch?.[1];
  if (projectId !== undefined) return { page: "create_orb", projectId };
  const focusedProjectMatch = /^\/projects\/([^/]+)$/.exec(path);
  const focusedProjectId = focusedProjectMatch?.[1];
  if (focusedProjectId !== undefined) return { page: "projects", focusedProjectId };
  const orbMatch = /^\/orbs\/([^/]+)$/.exec(path);
  const orbId = orbMatch?.[1];
  if (orbId !== undefined) return { page: "orb", orbId };
  return { page: "not_found" };
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHash(): string {
  return window.location.hash;
}

function AppRoutes({ cache }: { cache: TranscriptCache }) {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  const route = parseRoute(hash);
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

function PrivateApp() {
  const [cache] = useState(() => new TranscriptCache());
  return (
    <TranscriptCacheContext.Provider value={cache}>
      <AppSearchProvider>
        <AppRoutes cache={cache} />
      </AppSearchProvider>
    </TranscriptCacheContext.Provider>
  );
}

export function App() {
  const principal = useSyncExternalStore(
    subscribeToBrowserSession,
    readSessionPrincipal,
    readSessionPrincipal,
  );
  return (
    <div className="app">
      <IconSprite />
      <SessionRibbon />
      {principal !== null && <PrivateApp key={principal} />}
    </div>
  );
}

import { useSyncExternalStore } from "react";
import { AppSearchButton, AppSearchProvider } from "./components/AppSearch.tsx";
import { CreateOrbPage } from "./pages/CreateOrbPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OrbPage } from "./pages/OrbPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";

export type Route =
  | { page: "projects"; focusedProjectId: string | null }
  | { page: "create_orb"; projectId: string }
  | { page: "orb"; orbId: string }
  | { page: "not_found" };

export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/") return { page: "projects", focusedProjectId: null };
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

function AppRoutes() {
  const hash = useSyncExternalStore(subscribeToHash, readHash);
  const route = parseRoute(hash);
  return (
    <div className="app">
      {route.page === "projects" ? (
        <>
          <header className="app-header">
            <a href="#/" className="app-title">
              pi-orb
            </a>
            <AppSearchButton />
          </header>
          <div className="app-main">
            <ProjectsPage focusedProjectId={route.focusedProjectId} />
          </div>
        </>
      ) : route.page === "create_orb" ? (
        <CreateOrbPage key={route.projectId} projectId={route.projectId} />
      ) : route.page === "orb" ? (
        <OrbPage key={route.orbId} orbId={route.orbId} />
      ) : (
        <NotFoundPage />
      )}
    </div>
  );
}

export function App() {
  return (
    <AppSearchProvider>
      <AppRoutes />
    </AppSearchProvider>
  );
}

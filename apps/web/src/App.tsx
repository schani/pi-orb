import { useSyncExternalStore } from "react";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { OrbPage } from "./pages/OrbPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";

type Route = { page: "projects" } | { page: "orb"; orbId: string } | { page: "not_found" };

function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/") return { page: "projects" };
  const match = /^\/orbs\/([^/]+)$/.exec(path);
  const orbId = match?.[1];
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

export function App() {
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
          </header>
          <div className="app-main">
            <ProjectsPage />
          </div>
        </>
      ) : route.page === "orb" ? (
        <OrbPage key={route.orbId} orbId={route.orbId} />
      ) : (
        <NotFoundPage />
      )}
    </div>
  );
}

/// <reference types="vite/client" />

interface Window {
  readonly piOrbDebug: {
    readonly dump: () => import("./lib/dev-console-debug.ts").PiOrbDebugDump;
  };
}

declare module "@wterm/react/css";

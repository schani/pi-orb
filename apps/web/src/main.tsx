import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installDevConsoleDebug } from "./lib/dev-console-debug.ts";
import "@wterm/react/css";
import "./styles.css";

installDevConsoleDebug(window);

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import {
  beginSessionRequest,
  readSessionGeneration,
  reportSessionPrincipal,
  resetBrowserSessionForTest,
} from "../lib/session.ts";
import { LogoutButton } from "./LogoutButton.tsx";

beforeEach(resetBrowserSessionForTest);

it("hides sign out without a cookie-session capability", () => {
  reportSessionPrincipal(beginSessionRequest(), "user:local");
  expect(renderToStaticMarkup(<LogoutButton />)).toBe("");
});

it("offers an accessible action without replacing the principal generation", () => {
  reportSessionPrincipal(beginSessionRequest(), "user:alice");
  const generation = readSessionGeneration();
  reportSessionPrincipal(beginSessionRequest(), "user:alice", true);
  expect(readSessionGeneration()).toBe(generation);
  expect(renderToStaticMarkup(<LogoutButton />)).toContain('type="button">Sign out</button>');
  reportSessionPrincipal(beginSessionRequest(), "ops:operator");
  expect(renderToStaticMarkup(<LogoutButton />)).toBe("");
});

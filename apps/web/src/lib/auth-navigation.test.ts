import { afterEach, expect, it, vi } from "vitest";
import { signIn } from "./auth-navigation.ts";

afterEach(() => vi.unstubAllGlobals());

it("starts explicit same-tab login with the full relative return target", () => {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname: "/", search: "?view=one", hash: "#/orbs/a", assign },
  });
  signIn();
  expect(assign).toHaveBeenCalledWith("/auth/login?returnTo=%2F%3Fview%3Done%23%2Forbs%2Fa");
});

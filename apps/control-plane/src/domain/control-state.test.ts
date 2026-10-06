import { expect, it } from "vitest";
import { ControlState } from "./control-state.ts";

it("closes scopes once, releases demand immediately, and retains unregister activity", () => {
  const control = new ControlState();
  let conversation = 0;
  let execution = 0;
  control.registerBrowserConnection("orb", "terminal-named-conversation", () => conversation++);
  control.registerBrowserConnection("orb", "plain-id", () => execution++, "execution");
  control.setBrowserVisibility("orb", "plain-id", true, 10);
  control.closeBrowserConnections("orb", "execution");
  expect(execution).toBe(1);
  expect(conversation).toBe(0);
  expect(control.hasVisibleBrowser("orb")).toBe(false);
  control.setBrowserVisibility("orb", "plain-id", true, 15);
  expect(control.hasVisibleBrowser("orb")).toBe(false);
  control.closeBrowserConnections("orb", "execution");
  control.unregisterBrowserConnection("orb", "plain-id", 20);
  control.unregisterBrowserConnection("orb", "plain-id", 30);
  expect(control.getLastVisibleAt("orb")).toBe(20);
  control.setBrowserVisibility("orb", "terminal-named-conversation", true, 40);
  expect(control.hasVisibleBrowser("orb")).toBe(true);
  control.closeBrowserConnections("orb");
  control.closeBrowserConnections("orb");
  expect(conversation).toBe(1);
  expect(execution).toBe(1);
  expect(control.hasVisibleBrowser("orb")).toBe(false);
});

it.each([false, true])(
  "terminal cleanup closes execution and preserves conversation only when requested: %s",
  (preserve) => {
    const control = new ControlState();
    let conversation = 0;
    let execution = 0;
    control.registerBrowserConnection("orb", "conversation", () => conversation++);
    control.registerBrowserConnection("orb", "execution", () => execution++, "execution");
    control.setBrowserVisibility("orb", "conversation", true, 10);
    control.setBrowserVisibility("orb", "execution", true, 10);
    control.clearOrb("orb", preserve);
    control.clearOrb("orb", preserve);
    expect(execution).toBe(1);
    expect(conversation).toBe(preserve ? 0 : 1);
    expect(control.hasVisibleBrowser("orb")).toBe(preserve);
  },
);

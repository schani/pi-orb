import { describe, expect, it } from "vitest";
import {
  installSafariLinks,
  launchSafariAuth,
  type SafariLinkHost,
  safariAuthUrl,
  safariUrl,
} from "./safari-links.ts";

const APP = "https://pi-orb.example";

describe("safariUrl", () => {
  it.each([
    ["https://github.com/schani/pi-orb", "x-safari-https://github.com/schani/pi-orb"],
    [
      "https://files---pi-orb.run.app/s/x/a.html?q=1#top",
      "x-safari-https://files---pi-orb.run.app/s/x/a.html?q=1#top",
    ],
    ["http://example.com", "x-safari-http://example.com/"],
    ["https://pi-orb.example:8443/", "x-safari-https://pi-orb.example:8443/"],
  ])("routes external %s to Safari", (href, expected) => {
    expect(safariUrl(new URL(href), APP)).toBe(expected);
  });

  it.each([
    "https://pi-orb.example/orbs/abc",
    "mailto:a@example.com",
    "tel:+15555550100",
    "blob:https://pi-orb.example/0d1c",
    "x-safari-https://github.com/",
    "javascript:void(0)",
    "data:text/plain,hi",
  ])("leaves %s alone", (href) => {
    expect(safariUrl(new URL(href), APP)).toBeNull();
  });
});

interface FakeClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

function harness(navigator: SafariLinkHost["navigator"]) {
  const listeners: { type: string; listener: (event: MouseEvent) => void; capture: boolean }[] = [];
  const navigations: string[] = [];
  const host: SafariLinkHost = {
    navigator,
    document: {
      addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
    },
    location: {
      origin: APP,
      assign: (url) => navigations.push(url),
    },
  };
  const click = (href: string | null, overrides: Partial<FakeClick> = {}): FakeClick => {
    const anchor = href === null ? null : new URL(href);
    const event: FakeClick = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      target: {
        closest: (selector: string) => (selector === "a[href]" ? anchor : null),
      } as unknown as EventTarget,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...overrides,
    };
    for (const { listener } of listeners) listener(event as unknown as MouseEvent);
    return event;
  };
  return { host, listeners, navigations, click };
}

describe("installSafariLinks", () => {
  const ipad = { standalone: true, maxTouchPoints: 5 };

  it("installs one capture-phase click listener in an iOS standalone app", () => {
    const { host, listeners } = harness(ipad);
    expect(installSafariLinks(host)).toBe(true);
    expect(listeners.map(({ type, capture }) => ({ type, capture }))).toEqual([
      { type: "click", capture: true },
    ]);
  });

  it.each([
    { standalone: false, maxTouchPoints: 5 },
    { maxTouchPoints: 5 },
    { standalone: true, maxTouchPoints: 0 },
    { standalone: true, maxTouchPoints: 1 },
  ])("is not installed for %o", (navigator) => {
    const { host, listeners } = harness(navigator);
    expect(installSafariLinks(host)).toBe(false);
    expect(listeners).toEqual([]);
  });

  it("opens an external link in Safari instead of following it", () => {
    const { host, navigations, click } = harness(ipad);
    installSafariLinks(host);
    const event = click("https://github.com/schani/pi-orb?tab=readme#top");
    expect(event.defaultPrevented).toBe(true);
    expect(navigations).toEqual(["x-safari-https://github.com/schani/pi-orb?tab=readme#top"]);
  });

  it("navigates through the injected function when given", () => {
    const { host, navigations, click } = harness(ipad);
    const injected: string[] = [];
    installSafariLinks(host, (url) => injected.push(url));
    click("http://example.com/a");
    expect(injected).toEqual(["x-safari-http://example.com/a"]);
    expect(navigations).toEqual([]);
  });

  it.each<[string, string | null, Partial<FakeClick>]>([
    ["same-origin link", `${APP}/orbs/abc`, {}],
    ["mailto link", "mailto:a@example.com", {}],
    ["tel link", "tel:+15555550100", {}],
    ["blob link", `blob:${APP}/0d1c`, {}],
    ["x-safari link", "x-safari-https://github.com/", {}],
    ["javascript link", "javascript:void(0)", {}],
    ["click outside a link", null, {}],
    ["meta click", "https://github.com/", { metaKey: true }],
    ["ctrl click", "https://github.com/", { ctrlKey: true }],
    ["shift click", "https://github.com/", { shiftKey: true }],
    ["alt click", "https://github.com/", { altKey: true }],
    ["middle click", "https://github.com/", { button: 1 }],
    ["already prevented click", "https://github.com/", { defaultPrevented: true }],
    ["non-element target", "https://github.com/", { target: {} as EventTarget }],
    ["null target", "https://github.com/", { target: null }],
  ])("leaves a %s alone", (_name, href, overrides) => {
    const { host, navigations, click } = harness(ipad);
    installSafariLinks(host);
    const event = click(href, overrides);
    expect(event.defaultPrevented).toBe(overrides.defaultPrevented ?? false);
    expect(navigations).toEqual([]);
  });
});

describe("safariAuthUrl", () => {
  it("explicitly hands same-origin MCP settings to the receiving browser", () => {
    const { host } = harness({ standalone: true, maxTouchPoints: 5 });
    expect(safariAuthUrl("/projects/abc/mcp", host)).toBe(`x-safari-${APP}/projects/abc/mcp`);
  });
  it.each([
    [{ standalone: true, maxTouchPoints: 5 }, "x-safari-https://auth.example/consent?state=opaque"],
    [{ standalone: false, maxTouchPoints: 5 }, null],
    [{ maxTouchPoints: 5 }, null],
    [{ standalone: true, maxTouchPoints: 0 }, null],
  ] as const)("routes programmatic consent for %o", (navigator, expected) => {
    const { host } = harness(navigator);
    expect(safariAuthUrl("https://auth.example/consent?state=opaque", host)).toBe(expected);
  });

  it.each(["mailto:owner@example.com", "https://["])(
    "preserves nonexternal navigation: %s",
    (url) => {
      const { host } = harness({ standalone: true, maxTouchPoints: 5 });
      expect(safariAuthUrl(url, host)).toBeNull();
    },
  );
});

describe("launchSafariAuth", () => {
  it("assigns through the browser adapter", () => {
    const { host, navigations } = harness({ standalone: true, maxTouchPoints: 5 });
    expect(launchSafariAuth("x-safari-https://auth.example/", host).isOk()).toBe(true);
    expect(navigations).toEqual(["x-safari-https://auth.example/"]);
  });
  it("returns a typed sanitized platform failure", () => {
    const { host } = harness({ standalone: true, maxTouchPoints: 5 });
    host.location.assign = () => {
      throw new Error("private URL");
    };
    expect(launchSafariAuth("x-safari-https://auth.example/", host)._unsafeUnwrapErr()).toEqual({
      type: "safari_launch_failed",
    });
  });
});

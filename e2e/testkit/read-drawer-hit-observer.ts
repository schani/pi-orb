import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Locator, Page } from "@playwright/test";

interface BrowserElement {
  tagName: string;
  parentElement: BrowserElement | null;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  isConnected: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(element: BrowserElement): boolean;
  getBoundingClientRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}
interface BrowserEvent {
  target: unknown;
  isTrusted: boolean;
  clientX: number;
  clientY: number;
}
interface BrowserView {
  innerWidth: number;
  innerHeight: number;
  Element: new (...args: never[]) => BrowserElement;
  document: {
    querySelectorAll(selector: string): Iterable<BrowserElement>;
    elementFromPoint(x: number, y: number): BrowserElement | null;
    elementsFromPoint(x: number, y: number): BrowserElement[];
    addEventListener(name: string, callback: (event: BrowserEvent) => void, capture: boolean): void;
  };
  getComputedStyle(element: BrowserElement): {
    overflowY: string;
    position: string;
    transform: string;
    getPropertyValue(name: string): string;
  };
  requestAnimationFrame(callback: () => void): void;
}

/** Diagnostic only: no scrolling, disclosure changes, CSS changes or click retries. */
export async function observeReadDrawerHit(page: Page) {
  const requests: { phase: string; path: string; status?: number }[] = [];
  const admissions: unknown[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/details/")) requests.push({ phase: "request", path });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.includes("/details/"))
      requests.push({ phase: "response", path, status: response.status() });
  });
  page.on("console", async (message) => {
    if (message.text().startsWith("display detail")) {
      for (const arg of message.args().slice(1)) {
        const value = await arg.jsonValue().catch(() => null);
        if (value && typeof value === "object") {
          const { orbId, recordId, detailKey, outcome, bytes } = value;
          admissions.push({ orbId, recordId, detailKey, outcome, bytes });
        }
      }
    }
  });
  await page.addInitScript(() => {
    const view = globalThis as unknown as BrowserView;
    const { document, Element, getComputedStyle, requestAnimationFrame } = view;
    const identities = new WeakMap<BrowserElement, number>();
    let nextId = 1;
    const identity = (element: BrowserElement | null): unknown => {
      if (!element) return null;
      if (!identities.has(element)) identities.set(element, nextId++);
      return {
        node: identities.get(element),
        tag: element.tagName,
        classes: element.getAttribute("class"),
        parent: element.parentElement ? identityShallow(element.parentElement) : null,
      };
    };
    const identityShallow = (element: BrowserElement) => {
      if (!identities.has(element)) identities.set(element, nextId++);
      return identities.get(element);
    };
    const rect = (element: BrowserElement) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const state = {
      events: [] as unknown[],
      targets: [] as BrowserElement[],
      checkpoint: "boot",
      lastGeometry: "",
      snapshot: () => {
        const { innerWidth, innerHeight } = view;
        const headers = Array.from(document.querySelectorAll(".tool-activity-category > summary"));
        return {
          viewport: {
            width: innerWidth,
            height: innerHeight,
            x: Reflect.get(globalThis, "scrollX"),
            y: Reflect.get(globalThis, "scrollY"),
          },
          headers: headers.map((header) => ({
            identity: identity(header),
            rect: rect(header),
            open: header.parentElement?.hasAttribute("open"),
          })),
          targets: state.targets.map((target) => {
            const box = target.getBoundingClientRect();
            const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
            const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
            const hit = document.elementFromPoint(x, y);
            const ancestors = [];
            for (let node: BrowserElement | null = target; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              ancestors.push({
                identity: identity(node),
                rect: rect(node),
                scrollTop: node.scrollTop,
                scrollLeft: node.scrollLeft,
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
                overflowY: style.overflowY,
                position: style.position,
                transform: style.transform,
                overflowAnchor: style.getPropertyValue("overflow-anchor"),
                open: node.tagName === "DETAILS" ? node.hasAttribute("open") : undefined,
              });
            }
            return {
              identity: identity(target),
              connected: target.isConnected,
              rect: rect(target),
              center: { x, y },
              hit: identity(hit),
              hitRect: hit ? rect(hit) : null,
              admitted: hit !== null && target.contains(hit),
              stack: document.elementsFromPoint(x, y).map(identity),
              ancestors,
            };
          }),
        };
      },
      record: (kind: string, extra: unknown = null) => {
        state.events.push({ time: performance.now(), checkpoint: state.checkpoint, kind, extra });
        if (state.events.length > 600) state.events.shift();
      },
    };
    Object.assign(globalThis, { __readDrawerHit: state });
    for (const kind of ["pointerdown", "pointerup", "click", "toggle", "scroll"]) {
      document.addEventListener(
        kind,
        (event) => {
          const pointer = event;
          state.record(kind, {
            target: identity(event.target instanceof Element ? event.target : null),
            x: pointer.clientX,
            y: pointer.clientY,
            trusted: event.isTrusted,
            hit: Number.isFinite(pointer.clientX)
              ? identity(document.elementFromPoint(pointer.clientX, pointer.clientY))
              : null,
            geometry: state.snapshot(),
          });
        },
        true,
      );
    }
    const frame = () => {
      if (state.targets.length) {
        const geometry = state.snapshot();
        const serialized = JSON.stringify(geometry);
        if (serialized !== state.lastGeometry) {
          state.record("geometry", geometry);
          state.lastGeometry = serialized;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return {
    async checkpoint(name: string, target?: Locator) {
      if (target)
        await target.evaluate((element) => {
          const state = Reflect.get(globalThis, "__readDrawerHit");
          if (!state.targets.includes(element)) state.targets.push(element);
        });
      await page.evaluate((name) => {
        const state = Reflect.get(globalThis, "__readDrawerHit");
        state.checkpoint = name;
        state.record("checkpoint", state.snapshot());
      }, name);
    },
    async save(label: string, failed: boolean) {
      const browser = await page.evaluate(() => {
        const state = Reflect.get(globalThis, "__readDrawerHit");
        return { events: state.events, final: state.snapshot() };
      });
      const dir = join(import.meta.dirname, "../../test-failures");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `2026-10-04-read-drawer-${label}-${Date.now()}.json.gz`);
      await writeFile(
        path,
        gzipSync(
          JSON.stringify(
            {
              kind: "browser-hit-diagnostic",
              replayable: false,
              notice: "NON-REPLAYABLE browser observations; not a determined trace.",
              failed,
              label,
              browserVersion: page.context().browser()?.version(),
              requests,
              admissions,
              browser,
            },
            null,
            2,
          ),
        ),
      );
      console.info(`Read drawer hit evidence: ${path}`);
    },
  };
}

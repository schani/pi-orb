import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";
import { ok, ResultAsync } from "neverthrow";

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function category(request: Request): string | null {
  const path = new URL(request.url()).pathname;
  if (path === "/api/v1/session") return "session";
  if (path === "/api/v1/projects") return "projects";
  if (/^\/api\/v1\/projects\/[^/]+\/orbs$/.test(path)) return "project-orbs";
  if (/^\/api\/v1\/orbs\/[^/]+$/.test(path)) return "metadata";
  if (/^\/api\/v1\/orbs\/[^/]+\/history$/.test(path)) return "history";
  if (request.resourceType?.() === "document" || request.resourceType?.() === "script")
    return request.resourceType();
  return null;
}

/** Metadata only: never read request headers, payloads, console arguments or model text. */
export function observeColdNavigation(page: Page) {
  const started = Date.now();
  type Entry = {
    id: number;
    category: string;
    method: string;
    url: string;
    at: number;
    stage: string;
    status?: number;
    headersAt?: number;
    completedAt?: number;
  };
  const requests = new Map<Request, Entry>();
  const interceptions: {
    category: string;
    stage: string;
    at: number;
    requestId?: number | undefined;
    records?: number;
    marker?: boolean;
  }[] = [];
  let crashes = 0,
    disconnections = 0,
    pageErrors = 0;
  const consoleTypes: Record<string, number> = {};
  const faults: {
    kind: string;
    name?: string;
    locations?: string[];
    url?: string;
    line?: number;
  }[] = [];
  const fault = (value: (typeof faults)[number]) => {
    faults.push(value);
    if (faults.length > 12) faults.shift();
  };
  const elapsed = () => Date.now() - started;
  const onRequest = (request: Request) => {
    const kind = category(request);
    if (kind === null || requests.size >= 80) return;
    requests.set(request, {
      id: requests.size + 1,
      category: kind,
      method: request.method(),
      url: safeUrl(request.url()),
      at: elapsed(),
      stage: "request",
    });
  };
  const onResponse = (response: Response) => {
    const entry = requests.get(response.request());
    if (entry) {
      entry.stage = "headers";
      entry.status = response.status();
      entry.headersAt = elapsed();
    }
  };
  const finish = (request: Request, stage: string) => {
    const entry = requests.get(request);
    if (entry) {
      entry.stage = stage;
      entry.completedAt = elapsed();
    }
  };
  const onFinished = (request: Request) => finish(request, "body-finished");
  const onFailed = (request: Request) => finish(request, "failed");
  const onCrash = () => {
    crashes++;
  };
  const onDisconnected = () => {
    disconnections++;
  };
  const onError = (error: Error) => {
    pageErrors++;
    fault({
      kind: "pageerror",
      name: ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError"].includes(
        error.name,
      )
        ? error.name
        : "other",
      locations: (error.stack?.match(/https?:\/\/[^\s)]+/g) ?? []).slice(0, 8).map(safeUrl),
    });
  };
  const onConsole = (message: ConsoleMessage) => {
    const type = message.type();
    consoleTypes[type] = (consoleTypes[type] ?? 0) + 1;
    if (["error", "warning"].includes(type) && message.location) {
      const location = message.location();
      fault({ kind: type, url: safeUrl(location.url), line: location.lineNumber });
    }
  };
  const browser = page.context().browser();
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("crash", onCrash);
  page.on("pageerror", onError);
  page.on("console", onConsole);
  browser?.on("disconnected", onDisconnected);
  return {
    stage(
      category: "history" | "navigation",
      stage: string,
      summary?: { records: number; marker: boolean },
      request?: Request,
    ) {
      interceptions.push({
        category,
        stage,
        at: elapsed(),
        ...(request === undefined ? {} : { requestId: requests.get(request)?.id }),
        ...summary,
      });
      if (interceptions.length > 80) interceptions.shift();
    },
    snapshot: () => ({
      capturedAt: new Date().toISOString(),
      url: safeUrl(page.url()),
      requests: [...requests.values()].map((entry) => ({ ...entry })),
      interceptions: [...interceptions],
      crashes,
      disconnections,
      pageErrors,
      consoleTypes: { ...consoleTypes },
      faults: [...faults],
    }),
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("crash", onCrash);
      page.off("pageerror", onError);
      page.off("console", onConsole);
      browser?.off("disconnected", onDisconnected);
    },
  };
}

/** Capture before teardown; content-bearing regions are masked, DOM data is structural. */
export async function captureColdNavigation(
  page: Page,
  evidence: ReturnType<typeof observeColdNavigation>,
  directory: string,
) {
  const snapshot = evidence.snapshot();
  const ioError = () => ({ type: "diagnostic_capture_failed" as const });
  const created = await ResultAsync.fromPromise(mkdir(directory, { recursive: true }), ioError);
  if (created.isErr()) return created;
  // Freeze the ledger at the failed assertion, before any browser diagnostic round trip.
  const written = await ResultAsync.fromPromise(
    writeFile(join(directory, "browser.json"), JSON.stringify(snapshot, null, 2)),
    ioError,
  );
  if (written.isErr()) return written;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dom = await Promise.race([
    ResultAsync.fromPromise(
      page.evaluate(() => {
        const target = globalThis as unknown as {
          document: {
            readyState: string;
            querySelectorAll(selector: string): { length: number };
            querySelector(
              selector: string,
            ): { getAttribute(name: string): string | null; childElementCount: number } | null;
          };
          piOrbDebug?: {
            dump(): {
              trace: { event: string; outcome?: string; recordCount?: number }[];
              current: { recordCount: number; synced: boolean } | null;
            };
          };
        };
        const debug = target.piOrbDebug?.dump();
        return {
          readyState: target.document.readyState,
          orbPages: target.document.querySelectorAll(".orb-page").length,
          mainBusy: target.document.querySelector(".orb-main")?.getAttribute("aria-busy"),
          mainChildren: target.document.querySelector(".orb-main")?.childElementCount,
          debug:
            debug === undefined
              ? null
              : {
                  navigation: debug.trace
                    .filter((entry) => entry.event === "navigation")
                    .map((entry) => ({
                      phase: ["cached_selection", "metadata_completion"].includes(
                        entry.outcome ?? "",
                      )
                        ? entry.outcome
                        : "other",
                      records: entry.recordCount,
                    })),
                  current:
                    debug.current === null
                      ? null
                      : { records: debug.current.recordCount, synced: debug.current.synced },
                },
        };
      }),
      ioError,
    ).then((result) => (result.isOk() ? result.value : { capture: "failed" })),
    new Promise<{ capture: string }>((resolve) => {
      timer = setTimeout(() => resolve({ capture: "timed-out" }), 1_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const structural = await ResultAsync.fromPromise(
    writeFile(join(directory, "dom.json"), JSON.stringify(dom, null, 2)),
    ioError,
  );
  if (structural.isErr()) return structural;
  const screenshot = await ResultAsync.fromThrowable(
    () =>
      page.screenshot({
        path: join(directory, "page.png"),
        timeout: 2_000,
        mask: [page.locator(".orb-main, .orb-index, input, textarea")],
      }),
    ioError,
  )();
  return ok({ structural: dom, screenshotCaptured: screenshot.isOk() });
}

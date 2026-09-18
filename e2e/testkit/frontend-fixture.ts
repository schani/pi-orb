import type { ConsoleMessage, Frame, Locator, Page, Request, Response } from "@playwright/test";

const MAX_OBSERVATIONS = 12;
const MAX_OBSERVATION_LENGTH = 240;
const MAX_PENDING_REQUESTS = 8;
const ROOT_SNAPSHOT_TIMEOUT_MS = 100;

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    const hash = url.hash;
    const hashQuery = hash.indexOf("?");
    url.hash = hash.startsWith("#/") ? hash.slice(0, hashQuery < 0 ? undefined : hashQuery) : "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function sanitizeText(value: string): string {
  const sanitized = value
    .replace(/https?:\/\/[^\s"')]+/gu, (url) => sanitizeUrl(url))
    .replace(/((?:\/|\.\/|\.\.\/)[^\s"'()?#]+)[?#][^\s"'()]*/gu, "$1")
    .replace(/\b(Bearer)\s+[^\s"']+/giu, "$1 <redacted>")
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|cookie|password|secret)\b["']?\s*[:=]\s*)[^\s,;}]+/giu,
      "$1<redacted>",
    )
    .replace(/[\r\n\t]+/gu, " ");
  return sanitized.slice(0, MAX_OBSERVATION_LENGTH);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isApi(request: Request): boolean {
  try {
    return new URL(request.url()).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function isProjects(request: Request): boolean {
  try {
    const path = new URL(request.url()).pathname;
    return path === "/api/v1/projects" || path.startsWith("/api/v1/projects/");
  } catch {
    return false;
  }
}

export function observeFrontendBoot(page: Page): {
  checkpoint(name: string): void;
  wait<T>(pending: Promise<T>): Promise<T>;
} {
  const checkpoints: string[] = [];
  const observations: string[] = [];
  const navigations: string[] = [];
  const trackedRequests = new Map<Request, { resource: string; url: string }>();
  const apiResponses: Record<string, number> = {};
  const projectResponses: Record<string, number> = {};
  const moduleResponses: Record<string, number> = {};
  let startedRequests = 0;
  let finishedRequests = 0;
  let failedRequests = 0;
  let apiRequests = 0;
  let projectRequests = 0;
  let moduleRequests = 0;
  let disposed = false;
  let mainFrameUrl = sanitizeUrl(page.url());
  const record = (value: string) => {
    observations.push(sanitizeText(value));
    if (observations.length > MAX_OBSERVATIONS) observations.shift();
  };
  const onRequest = (request: Request) => {
    const resource = request.resourceType();
    if (resource === "document" || resource === "script") {
      startedRequests += 1;
      trackedRequests.set(request, { resource, url: sanitizeUrl(request.url()) });
    }
    if (resource === "script") moduleRequests += 1;
    if (isApi(request)) apiRequests += 1;
    if (isProjects(request)) projectRequests += 1;
  };
  const onRequestFinished = (request: Request) => {
    if (!trackedRequests.delete(request)) return;
    finishedRequests += 1;
  };
  const onPageError = (error: Error) => record(`pageerror: ${error.name}: ${error.message}`);
  const onCrash = () => record("page: crashed");
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") record(`console: ${message.text()}`);
  };
  const onRequestFailed = (request: Request) => {
    if (trackedRequests.delete(request)) failedRequests += 1;
    record(
      `requestfailed: ${request.method()} ${sanitizeUrl(request.url())} ${request.failure()?.errorText ?? "unknown"}`,
    );
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    const status = String(response.status());
    if (request.resourceType() === "script") {
      increment(moduleResponses, status);
      if (response.status() >= 400)
        record(`module: ${response.status()} ${sanitizeUrl(response.url())}`);
    }
    if (isApi(request)) increment(apiResponses, status);
    if (isProjects(request)) increment(projectResponses, status);
    if (
      response.status() >= 400 &&
      ["document", "script", "stylesheet"].includes(request.resourceType())
    )
      record(`response: ${response.status()} ${sanitizeUrl(response.url())}`);
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    mainFrameUrl = sanitizeUrl(frame.url());
    navigations.push(mainFrameUrl);
    if (navigations.length > MAX_OBSERVATIONS) navigations.shift();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    page.off("request", onRequest);
    page.off("requestfinished", onRequestFinished);
    page.off("pageerror", onPageError);
    page.off("crash", onCrash);
    page.off("console", onConsole);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
    page.off("framenavigated", onFrameNavigated);
  };
  page.on("request", onRequest);
  page.on("requestfinished", onRequestFinished);
  page.on("pageerror", onPageError);
  page.on("crash", onCrash);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  page.on("framenavigated", onFrameNavigated);

  const snapshot = async () => {
    let rootTimer: ReturnType<typeof setTimeout> | undefined;
    const rootTimeout = new Promise<{ documentReadyState: string }>((resolve) => {
      rootTimer = setTimeout(
        () => resolve({ documentReadyState: "timed-out" }),
        ROOT_SNAPSHOT_TIMEOUT_MS,
      );
      rootTimer.unref?.();
    });
    const root = await Promise.race([
      page
        .evaluate(() => {
          const browserDocument = (
            globalThis as unknown as {
              document: {
                readyState: string;
                querySelector(selector: string): { childElementCount: number } | null;
              };
            }
          ).document;
          const element = browserDocument.querySelector("#root");
          return {
            documentReadyState: browserDocument.readyState,
            present: element !== null,
            childCount: element?.childElementCount ?? 0,
            fixtureControl:
              browserDocument.querySelector(".frontend-fixture-auth-control") !== null,
          };
        })
        .catch(() => ({ documentReadyState: "unavailable" })),
      rootTimeout,
    ]).finally(() => {
      if (rootTimer !== undefined) clearTimeout(rootTimer);
    });
    return {
      url: mainFrameUrl,
      navigations,
      checkpoints,
      root,
      requests: {
        started: startedRequests,
        finished: finishedRequests,
        failed: failedRequests,
        pending: [...trackedRequests.values()]
          .slice(-MAX_PENDING_REQUESTS)
          .map(({ resource, url }) => `${resource} ${url}`),
      },
      modules: { requested: moduleRequests, responses: moduleResponses },
      api: {
        requested: apiRequests,
        responses: apiResponses,
        projects: { requested: projectRequests, responses: projectResponses },
      },
      errors: observations,
    };
  };
  const report = async () => JSON.stringify(await snapshot());

  return {
    checkpoint(name: string) {
      checkpoints.push(sanitizeText(name));
    },
    async wait<T>(pending: Promise<T>): Promise<T> {
      try {
        return await pending;
      } catch (cause) {
        const reason = sanitizeText(cause instanceof Error ? cause.message : String(cause));
        throw new Error(`Frontend readiness failed: ${reason}; snapshot=${await report()}`);
      } finally {
        dispose();
      }
    },
  };
}

function isGetPath(request: { method(): string; url(): string }, path: string): boolean {
  return request.method() === "GET" && new URL(request.url()).pathname === path;
}

function projectsResponse(page: Page) {
  return page.waitForResponse((response) => isGetPath(response.request(), "/api/v1/projects"));
}

export async function gotoFrontendFixture(page: Page, url: string, ready?: Locator): Promise<void> {
  const boot = observeFrontendBoot(page);
  const projectsRequested = page
    .waitForRequest((request) => isGetPath(request, "/api/v1/projects"))
    .then(() => {
      boot.checkpoint("projects:requested");
    });
  const projects = projectsResponse(page).then((response) => {
    boot.checkpoint(`projects:response:${response.status()}`);
    if (!response.ok())
      throw new Error(`Initial project fixture request failed: ${response.status()}`);
    return response;
  });
  const navigation = page.goto(url).then((response) => {
    boot.checkpoint(`navigation:${response?.status() ?? "none"}`);
    return response;
  });
  const readiness = navigation.then(async () => {
    if (ready === undefined) return;
    await ready.waitFor({ state: "visible" });
    boot.checkpoint("ui:visible");
  });
  await boot.wait(Promise.all([navigation, projectsRequested, projects, readiness]));
}

export async function gotoFrontendHistory(
  page: Page,
  url: string,
  orbId: string,
  ready?: Locator,
): Promise<void> {
  const boot = observeFrontendBoot(page);
  const historyPath = `/api/v1/orbs/${orbId}/history`;
  const historyRequested = page
    .waitForRequest((request) => isGetPath(request, historyPath))
    .then(() => {
      boot.checkpoint("history:requested");
    });
  const history = page
    .waitForResponse((response) => isGetPath(response.request(), historyPath))
    .then((response) => {
      boot.checkpoint(`history:response:${response.status()}`);
      if (!response.ok())
        throw new Error(`Initial history fixture request failed: ${response.status()}`);
      return response;
    });
  const projectsRequested = page
    .waitForRequest((request) => isGetPath(request, "/api/v1/projects"))
    .then(() => {
      boot.checkpoint("projects:requested");
    });
  const projects = projectsResponse(page).then((response) => {
    boot.checkpoint(`projects:response:${response.status()}`);
    if (!response.ok())
      throw new Error(`Initial project fixture request failed: ${response.status()}`);
    return response;
  });
  const navigation = page.goto(url).then((response) => {
    boot.checkpoint(`navigation:${response?.status() ?? "none"}`);
    return response;
  });
  const readiness = navigation.then(async () => {
    if (ready === undefined) return;
    await ready.waitFor({ state: "visible" });
    boot.checkpoint("ui:visible");
  });
  await boot.wait(
    Promise.all([navigation, projectsRequested, projects, historyRequested, history, readiness]),
  );
}

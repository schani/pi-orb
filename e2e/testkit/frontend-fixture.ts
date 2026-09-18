import type { Page, Request } from "@playwright/test";

const MAX_OBSERVATIONS = 12;
const MAX_OBSERVATION_LENGTH = 240;
const MAX_PENDING_REQUESTS = 8;

function sanitizeUrl(value: string): string {
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

function sanitizeText(value: string): string {
  const sanitized = value
    .replace(/https?:\/\/[^\s"')]+/gu, (url) => sanitizeUrl(url))
    .replace(/((?:\/|\.\/|\.\.\/)[^\s"'()?#]+)[?#][^\s"'()]*/gu, "$1")
    .replace(/[\r\n\t]+/gu, " ");
  return sanitized.slice(0, MAX_OBSERVATION_LENGTH);
}

export function observeFrontendBoot(page: Page): {
  wait<T>(pending: Promise<T>): Promise<T>;
} {
  const observations: string[] = [];
  const trackedRequests = new Map<Request, { resource: string; url: string }>();
  let startedRequests = 0;
  let finishedRequests = 0;
  let failedRequests = 0;
  const record = (value: string) => {
    observations.push(sanitizeText(value));
    if (observations.length > MAX_OBSERVATIONS) observations.shift();
  };
  const onRequest = (request: Request) => {
    const resource = request.resourceType();
    if (resource !== "document" && resource !== "script") return;
    startedRequests += 1;
    trackedRequests.set(request, { resource, url: sanitizeUrl(request.url()) });
  };
  const onRequestFinished = (request: Request) => {
    if (!trackedRequests.delete(request)) return;
    finishedRequests += 1;
  };
  const onPageError = (error: Error) => record(`pageerror: ${error.name}: ${error.message}`);
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error") record(`console: ${message.text()}`);
  };
  const onRequestFailed = (request: Request) => {
    if (trackedRequests.delete(request)) failedRequests += 1;
    record(
      `requestfailed: ${request.method()} ${sanitizeUrl(request.url())} ${request.failure()?.errorText ?? "unknown"}`,
    );
  };
  const onResponse = (response: {
    request(): { resourceType(): string };
    status(): number;
    url(): string;
  }) => {
    if (
      response.status() >= 400 &&
      ["document", "script", "stylesheet"].includes(response.request().resourceType())
    )
      record(`response: ${response.status()} ${sanitizeUrl(response.url())}`);
  };
  page.on("request", onRequest);
  page.on("requestfinished", onRequestFinished);
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return {
    async wait<T>(pending: Promise<T>): Promise<T> {
      try {
        return await pending;
      } catch (cause) {
        const readiness = await page
          .evaluate(() => {
            const browserDocument = (
              globalThis as unknown as {
                document: {
                  readyState: string;
                  querySelector(selector: string): { childElementCount: number } | null;
                };
              }
            ).document;
            const root = browserDocument.querySelector("#root");
            return {
              document: browserDocument.readyState,
              appRoot: root !== null,
              appChildren: root?.childElementCount ?? 0,
              fixtureControl:
                browserDocument.querySelector(".frontend-fixture-auth-control") !== null,
            };
          })
          .catch(() => ({ document: "unavailable" }));
        const reason = sanitizeText(cause instanceof Error ? cause.message : String(cause));
        const pendingRequests = [...trackedRequests.values()]
          .slice(-MAX_PENDING_REQUESTS)
          .map(({ resource, url }) => `${resource} ${url}`);
        throw new Error(
          `Frontend boot did not reach its fixture request: ${reason}; ` +
            `url=${sanitizeUrl(page.url())}; readiness=${JSON.stringify(readiness)}; ` +
            `requests=${JSON.stringify({
              started: startedRequests,
              finished: finishedRequests,
              failed: failedRequests,
              pending: pendingRequests,
            })}; browser=${JSON.stringify(observations)}`,
        );
      } finally {
        page.off("request", onRequest);
        page.off("requestfinished", onRequestFinished);
        page.off("pageerror", onPageError);
        page.off("console", onConsole);
        page.off("requestfailed", onRequestFailed);
        page.off("response", onResponse);
      }
    },
  };
}

function projectsResponse(page: Page) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "GET" && new URL(response.url()).pathname === "/api/v1/projects";
  });
}

export async function gotoFrontendFixture(page: Page, url: string): Promise<void> {
  const boot = observeFrontendBoot(page);
  const projects = projectsResponse(page);
  const [, response] = await boot.wait(Promise.all([page.goto(url), projects]));
  if (!response.ok())
    throw new Error(`Initial project fixture request failed: ${response.status()}`);
}

export async function gotoFrontendHistory(page: Page, url: string, orbId: string): Promise<void> {
  const boot = observeFrontendBoot(page);
  const history = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "GET" &&
      new URL(response.url()).pathname === `/api/v1/orbs/${orbId}/history`
    );
  });
  const projects = projectsResponse(page);
  const [, loadedProjects, loadedHistory] = await boot.wait(
    Promise.all([page.goto(url), projects, history]),
  );
  if (!loadedProjects.ok() || !loadedHistory.ok())
    throw new Error(
      `Initial frontend fixture requests failed: projects=${loadedProjects.status()} history=${loadedHistory.status()}`,
    );
}

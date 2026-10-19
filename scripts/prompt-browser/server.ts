import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { CATALOG } from "./catalog.ts";
import { PromptService } from "./service.ts";
import { SourceAdapter } from "./source.ts";
import { MAX_CONTENT_BYTES, type PromptError } from "./types.ts";

const ASSETS: Readonly<Record<string, { path: string; type: string }>> = {
  "/": { path: "scripts/prompt-browser/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "scripts/prompt-browser/app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { path: "scripts/prompt-browser/app.css", type: "text/css; charset=utf-8" },
  "/styles.css": { path: "apps/web/src/styles.css", type: "text/css; charset=utf-8" },
  "/neverthrow.js": {
    path: "node_modules/neverthrow/dist/index.es.js",
    type: "text/javascript; charset=utf-8",
  },
  ...Object.fromEntries(
    [
      "jetbrains-mono-bold-f73d6b79ab0c.woff2",
      "jetbrains-mono-regular-fa06becb7e66.woff2",
      "jetbrains-mono-italic-406a79f3245e.woff2",
      "iosevka-etoile-regular-989cbc25c646.woff2",
      "iosevka-etoile-italic-ff9ea6b1ef88.woff2",
      "iosevka-etoile-bold-7ec739ec82b2.woff2",
    ].map((font) => [
      `/fonts/${font}`,
      { path: `apps/web/public/fonts/${font}`, type: "font/woff2" },
    ]),
  ),
};
const STATUSES: Record<PromptError["code"], number> = {
  unsupported: 422,
  not_found: 404,
  read_only: 403,
  conflict: 409,
  syntax: 422,
  unsafe_path: 403,
  too_large: 413,
  invalid_request: 400,
  io: 500,
  unauthorized: 401,
  forbidden: 403,
};
const MAX_REQUEST_BYTES = MAX_CONTENT_BYTES * 6 + 65_536;
const failure = (code: PromptError["code"], message: string): PromptError => ({ code, message });

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function reject(response: ServerResponse, error: PromptError): void {
  json(response, STATUSES[error.code], { error });
}
function readBody(request: IncomingMessage): ResultAsync<unknown, PromptError> {
  return new ResultAsync(
    new Promise((done) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          chunks.length = 0;
          done(err(failure("too_large", "Request body is too large.")));
        } else chunks.push(chunk);
      });
      request.on("end", () => {
        if (size > MAX_REQUEST_BYTES) return;
        done(
          Result.fromThrowable(
            () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            () => failure("invalid_request", "Request body must be JSON."),
          )(),
        );
      });
      request.on("error", () =>
        done(err(failure("invalid_request", "Request body could not be read."))),
      );
      request.on("aborted", () =>
        done(err(failure("invalid_request", "Request was interrupted."))),
      );
    }),
  );
}
function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface Running {
  server: Server;
  token: string;
  port: number;
  url: string;
  close(): ResultAsync<void, PromptError>;
}
export interface Options {
  port?: number;
  previewHost?: string;
  root?: string;
  service?: PromptService;
}

export function start(options: Options = {}): ResultAsync<Running, PromptError> {
  const port = options.port ?? 5188;
  const previewHost = options.previewHost ?? process.env.PI_ORB_PREVIEW_HOST;
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (previewHost !== undefined && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(previewHost))
  ) {
    return errAsync(failure("invalid_request", "Invalid port or preview hostname."));
  }
  const service =
    options.service ??
    new PromptService(
      new SourceAdapter(options.root ?? resolve(import.meta.dirname, "../..")),
      CATALOG,
    );
  const token = randomBytes(32).toString("hex");
  let boundPort = port;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const host = request.headers.host ?? "";
    const allowedHosts = [
      `localhost:${boundPort}`,
      `127.0.0.1:${boundPort}`,
      ...(previewHost ? [`${previewHost}:${boundPort}`] : []),
    ];
    if (!allowedHosts.includes(host))
      return reject(response, failure("forbidden", "Unexpected Host."));
    const origin = request.headers.origin;
    if (
      (origin !== undefined && origin !== `http://${host}`) ||
      ((request.method === "PUT" || request.method === "POST") && origin === undefined)
    ) {
      return reject(response, failure("forbidden", "Expected the exact same Origin."));
    }
    const raw = request.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//"))
      return reject(response, failure("invalid_request", "Invalid request URL."));
    const path = raw.split("?")[0];
    if (path === "/api/render" || path === "/api/prompts" || path.startsWith("/api/prompts/")) {
      if (!authorized(request, token))
        return reject(response, failure("unauthorized", "A valid bearer token is required."));
      if (request.method === "POST" && path === "/api/render") {
        if (
          request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json"
        )
          return reject(
            response,
            failure("invalid_request", "Expected application/json Content-Type."),
          );
        const body = await readBody(request);
        if (body.isErr()) return reject(response, body.error);
        const rendered = await service.render(body.value);
        if (rendered.isErr()) return reject(response, rendered.error);
        return json(response, 200, rendered.value);
      }
      if (request.method === "GET" && path === "/api/prompts") {
        const listed = await service.list();
        if (listed.isErr()) return reject(response, listed.error);
        return json(response, 200, { entries: listed.value });
      }
      if (request.method === "PUT" && path.startsWith("/api/prompts/")) {
        if (
          request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json"
        ) {
          return reject(
            response,
            failure("invalid_request", "Expected application/json Content-Type."),
          );
        }
        const id = Result.fromThrowable(
          () => decodeURIComponent(path.slice("/api/prompts/".length)),
          () => failure("invalid_request", "Invalid prompt ID."),
        )();
        if (id.isErr()) return reject(response, id.error);
        const body = await readBody(request);
        if (body.isErr()) return reject(response, body.error);
        const saved = await service.save(id.value, body.value);
        if (saved.isErr()) return reject(response, saved.error);
        return json(response, 200, saved.value);
      }
      return reject(response, failure("not_found", "Prompt endpoint doesn't exist."));
    }
    const asset = Object.hasOwn(ASSETS, path) ? ASSETS[path] : undefined;
    if (request.method === "GET" && asset) {
      const content = await service.asset(asset.path);
      if (content.isErr()) return reject(response, content.error);
      response.writeHead(200, { "Content-Type": asset.type });
      response.end(content.value);
      return;
    }
    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><title>Not found</title><p>This page doesn\'t exist.</p><a href="/">Prompt browser</a>',
    );
  }

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      // Node's callback contract cannot return Result; contain unexpected adapter failures here.
      void ResultAsync.fromThrowable(
        () => handle(request, response),
        () => failure("io", "Request could not be completed."),
      )().mapErr((error) => {
        if (!response.headersSent) reject(response, error);
        else response.destroy();
        return error;
      });
    },
  );
  return new ResultAsync(
    new Promise((done) => {
      const onError = () => done(err(failure("io", "Could not bind the prompt browser port.")));
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          done(err(failure("io", "Could not determine the prompt browser port.")));
          return;
        }
        boundPort = address.port;
        done(
          ok({
            server,
            token,
            port: boundPort,
            url: `http://${previewHost ?? "127.0.0.1"}:${boundPort}/#token=${token}`,
            close: () =>
              new ResultAsync(
                new Promise((closed) =>
                  server.close((error) =>
                    closed(
                      error ? err(failure("io", "Could not close prompt browser.")) : ok(undefined),
                    ),
                  ),
                ),
              ),
          }),
        );
      });
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const parsedPort = process.env.PORT === undefined ? 5188 : Number(process.env.PORT);
  const result = await start({ port: parsedPort });
  if (result.isErr()) {
    console.error(`${result.error.code}: ${result.error.message}`);
    process.exitCode = 1;
  } else console.log(`Prompt editor (changes apply to this checkout):\n${result.value.url}`);
}

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { err, ok, Result } from "neverthrow";

export function redirectResponse(method, path, origin) {
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } };
  }
  if (!path.startsWith("/") || /^\/(?:api|auth|\.well-known)(?:\/|\?|$)/.test(path)) {
    return { status: 404, headers: { "Cache-Control": "no-store" } };
  }
  return { status: 302, headers: { Location: origin + path, "Cache-Control": "no-store" } };
}

export function configuration(env) {
  const origin = env.PI_ORB_REDIRECT_ORIGIN;
  const port = Number(env.PORT ?? "8080");
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(origin ?? "")) {
    return err({ type: "redirect_configuration_error", field: "PI_ORB_REDIRECT_ORIGIN" });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return err({ type: "redirect_configuration_error", field: "PORT" });
  }
  return ok({ origin, port });
}

export function redirectServer(origin) {
  return createServer((request, response) => {
    const result = redirectResponse(request.method, request.url ?? "", origin);
    response.writeHead(result.status, result.headers);
    response.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = configuration(process.env).andThen(({ origin, port }) => {
    return Result.fromThrowable(
      () => {
        const server = redirectServer(origin);
        server.on("error", () => {
          console.error("browser-redirect: listen_error");
          process.exitCode = 1;
        });
        return server.listen(port, "0.0.0.0");
      },
      () => ({ type: "redirect_listen_error" }),
    )();
  });
  if (started.isErr()) {
    console.error(`browser-redirect: ${started.error.type}`);
    process.exitCode = 1;
  }
}

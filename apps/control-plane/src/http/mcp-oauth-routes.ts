import { createHash, randomBytes } from "node:crypto";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { err, ok } from "neverthrow";
import type { McpStore } from "../domain/mcp.ts";
import { type McpOAuth, type McpOAuthError, oauthError } from "../domain/mcp-oauth.ts";

export const MCP_OAUTH_CALLBACK = "/api/v1/mcp/oauth/callback";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const oauthHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function sendOAuthError(reply: FastifyReply, error: McpOAuthError, setupUrl?: string) {
  const messages = {
    not_found: "MCP connection doesn't exist",
    conflict: "MCP connection changed; reload",
    unavailable: "MCP OAuth unavailable",
    auth_required: "MCP authorization required",
    invalid_request: "Invalid or expired MCP authorization",
  };
  return reply
    .code(
      { not_found: 404, conflict: 409, unavailable: 503, auth_required: 401, invalid_request: 400 }[
        error.code
      ],
    )
    .send({
      error: {
        code: error.code,
        message: messages[error.code] + (setupUrl ? ` — [Project MCP settings](${setupUrl})` : ""),
        retryable: error.code === "unavailable",
      },
    });
}
export async function oauthBinding(
  task: SimulationTask,
  catalog: McpStore,
  projectId: string,
  id: string,
) {
  if (!uuid.test(projectId) || !uuid.test(id)) return err(oauthError("not_found"));
  const read = await catalog.read(task, projectId);
  if (read.isErr())
    return err(oauthError(read.error.code === "unavailable" ? "unavailable" : "not_found"));
  const config = read.value.servers.find((s) => s.oauth?.id === id);
  return config ? ok({ projectId, id, url: config.url }) : err(oauthError("not_found"));
}

export function registerMcpOAuthRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  catalog: McpStore,
  oauth: McpOAuth,
  appOrigin: string,
) {
  const path = "/api/v1/projects/:projectId/mcp/:id/oauth";
  const cookieName = (id: string) =>
    `${appOrigin.startsWith("https:") ? "__Host-pi-orb-mcp-" : "pi_orb_mcp_"}${id}`;
  app.get<{ Querystring: { projectId?: string } }>("/mcp/oauth/failed", async (request, reply) => {
    const projectId = request.query.projectId;
    const setup =
      typeof projectId === "string" && uuid.test(projectId)
        ? `<a href='/#/projects/${projectId}/mcp'>MCP settings</a> · `
        : "";
    return reply
      .code(400)
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; frame-ancestors 'none'")
      .type("text/html")
      .send(`<p>MCP authorization failed or expired.</p>${setup}<a href='/'>Dashboard</a>`);
  });
  type Params = { projectId: string; id: string };
  app.get<{ Params: Params }>(path, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const binding = await oauthBinding(task, catalog, request.params.projectId, request.params.id);
    if (binding.isErr()) return sendOAuthError(reply, binding.error);
    const result = await oauth.status(task, binding.value);
    return result.isErr()
      ? sendOAuthError(reply, result.error)
      : reply.send({ status: result.value });
  });
  for (const action of ["connect", "disconnect"] as const) {
    app.post<{ Params: Params }>(`${path}/${action}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (
        request.headers.origin !== appOrigin ||
        !request.headers["content-type"]?.startsWith("application/json")
      )
        return reply.code(403).send({
          error: {
            code: "forbidden",
            message: "OAuth request origin rejected",
            retryable: false,
          },
        });
      const binding = await oauthBinding(
        task,
        catalog,
        request.params.projectId,
        request.params.id,
      );
      if (binding.isErr()) return sendOAuthError(reply, binding.error);
      if (action === "disconnect") {
        const result = await oauth.disconnect(task, binding.value);
        return result.isErr()
          ? sendOAuthError(reply, result.error)
          : reply.send({ status: "auth_required" });
      }
      const browser = randomBytes(32).toString("hex");
      const state = `${binding.value.projectId}.${binding.value.id}.${randomBytes(32).toString("hex")}`;
      const result = await oauth.start(task, binding.value, oauthHash(state), oauthHash(browser));
      // The adapter gets only the hash as opaque state; include routing outside that hash.
      if (result.isErr()) return sendOAuthError(reply, result.error);
      const url = new URL(result.value.url);
      url.searchParams.set("state", state);
      reply.header(
        "set-cookie",
        `${cookieName(binding.value.id)}=${browser}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${appOrigin.startsWith("https:") ? "; Secure" : ""}`,
      );
      return reply.send({ url: url.toString() });
    });
  }
  app.get<{ Querystring: { state?: string; code?: string; iss?: string; error?: string } }>(
    MCP_OAUTH_CALLBACK,
    async (request, reply) => {
      reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
      const invalid = () => reply.code(303).redirect(`${appOrigin}/mcp/oauth/failed`);
      if (
        typeof request.query.state !== "string" ||
        (request.query.code !== undefined && typeof request.query.code !== "string") ||
        (request.query.iss !== undefined && typeof request.query.iss !== "string")
      )
        return invalid();
      const state = request.query.state;
      const [projectId = "", id = "", nonce = ""] = state.split(".");
      if (!/^[0-9a-f]{64}$/.test(nonce) || state.length !== 138) return invalid();
      const binding = await oauthBinding(task, catalog, projectId, id);
      if (binding.isErr())
        return reply
          .code(binding.error.code === "not_found" ? 404 : 503)
          .type("text/html")
          .send("<p>MCP connection doesn't exist or is unavailable.</p><a href='/'>Dashboard</a>");
      const cookie =
        request.headers.cookie
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith(`${cookieName(id)}=`))
          ?.split("=")[1] ?? "";
      if (!/^[0-9a-f]{64}$/.test(cookie)) return invalid();
      const completed = await oauth.complete(
        task,
        binding.value,
        oauthHash(state),
        oauthHash(cookie),
        request.query.error ? "" : (request.query.code ?? ""),
        request.query.iss,
      );
      reply.header(
        "set-cookie",
        `${cookieName(id)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${appOrigin.startsWith("https:") ? "; Secure" : ""}`,
      );
      if (completed.isErr())
        return reply.code(303).redirect(`${appOrigin}/mcp/oauth/failed?projectId=${projectId}`);
      return reply.code(303).redirect(`${appOrigin}/#/projects/${projectId}/mcp`);
    },
  );
}

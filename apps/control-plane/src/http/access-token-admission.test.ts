import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { createSealedPreviewAuth } from "../adapters/sealed-preview-cookies.ts";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
} from "../domain/access-token.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { registerPreviewAccessTokens, withFilesAccessTokens } from "./access-token-admission.ts";
import { registerAuthenticatedBrowserRoutes } from "./browser-identity.ts";
import { registerPreviewAuth } from "./preview-auth-routes.ts";
import { createPreviewHosts } from "./preview-host.ts";

const MINE = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const appOrigin = "https://app.example.com";
const filesOrigin = "https://files.example.org";
const task = new NoSimulationTask("access token admission", false);
const exp = Math.floor(task.wallNow() / 1000) + 600;
const token = "valid";

function setup() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("mine"), ownerUserId: "owner" });
  h.store.seedProject({ ...makeProjectRow("theirs"), ownerUserId: "coworker" });
  h.store.seedOrb(makeOrbRow(MINE, "mine", "running"));
  h.store.seedOrb(makeOrbRow(FOREIGN, "theirs", "running"));
  const claims = { iss: "https://issuer.test", aud: ACCESS_TOKEN_AUDIENCE, orb_id: MINE, exp };
  const verifier = {
    verify: (_task: unknown, jwt: string) =>
      jwt === token
        ? okAsync({ ...claims, token_use: "exchanged" })
        : errAsync({ type: "unauthenticated" as const, message: "bad signature" }),
  };
  return { verifier, store: h.store, issuerUrl: claims.iss };
}

it("admits same-owner previews by header or cookie before preview login", async () => {
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.net",
    appOrigin,
    filesOrigin,
  })._unsafeUnwrap();
  const host = (orbId: string) => new URL(hosts.url(orbId, 5173)._unsafeUnwrap()).host;
  const app = Fastify();
  registerPreviewAccessTokens(app, task, { hosts, tokens: setup() });
  registerPreviewAuth(app, {
    hosts,
    appOrigin,
    previewAuth: createSealedPreviewAuth(
      "a sufficiently long cookie sealing key",
      Date.now,
    )._unsafeUnwrap(),
    applicationAuth: {
      authenticateSession: () => errAsync({ type: "unauthenticated", message: "" }),
    },
  });
  app.addHook("onRequest", async (request, reply) => reply.send(request.previewIdentity ?? {}));
  const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const get = (orbId: string, headers: Record<string, string>) =>
    app.inject({ url: "/", headers: { host: host(orbId), ...navigation, ...headers } });
  for (const headers of [
    { [ACCESS_TOKEN_HEADER]: token },
    { cookie: `${ACCESS_TOKEN_COOKIE}=${token}`, upgrade: "websocket" },
  ])
    expect((await get(MINE, headers)).json()).toEqual({
      principal: { kind: "user", user: { id: "owner", email: null } },
      expiresAt: exp * 1000,
    });
  expect((await get(FOREIGN, { [ACCESS_TOKEN_HEADER]: token })).statusCode).toBe(403);
  const invalid = await get(MINE, { cookie: `${ACCESS_TOKEN_COOKIE}=forged` });
  expect(invalid.statusCode).toBe(401);
  expect(invalid.headers.location).toBeUndefined();
  expect((await get(MINE, {})).statusCode).toBe(302);
});

it.each(["s", "files", "files/repo"])(
  "admits same-owner %s files only on the files host, never via Google login",
  async (prefix) => {
    const startLogin = vi.fn(() =>
      okAsync({ authorizationUrl: "https://google", loginCookieValue: "" }),
    );
    const base = vi.fn(() => errAsync({ type: "unauthenticated" as const, message: "none" }));
    const app = Fastify();
    registerAuthenticatedBrowserRoutes(
      app,
      withFilesAccessTokens(base, task, { filesOrigin, tokens: setup() }),
      (scope) => {
        scope.get("/*", (request) => request.principal);
      },
      { origins: { appOrigin, filesOrigin }, auth: { startLogin } },
    );
    const get = (host: string, url: string, value = token) =>
      app.inject({
        url,
        headers: {
          host,
          [ACCESS_TOKEN_HEADER]: value,
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      });
    expect((await get("files.example.org", `/${prefix}/${MINE}/a.html`)).json()).toEqual({
      kind: "user",
      user: { id: "owner", email: null },
    });
    expect((await get("files.example.org", `/${prefix}/${FOREIGN}/a.html`)).statusCode).toBe(403);
    for (const [host, url, value] of [
      ["app.example.com", "/api/v1/projects", token],
      ["files.example.org", `/${prefix}/${MINE.replace("1", "%31")}/a.html`, token],
      ["files.example.org", `/${prefix}/${MINE}/a.html`, "forged"],
    ] as const)
      expect((await get(host, url, value)).statusCode).toBe(401);
    expect(startLogin).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
  },
);

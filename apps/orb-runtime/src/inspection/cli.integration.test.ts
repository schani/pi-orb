import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli as collectCli } from "../testkit/cli.ts";

const TOKEN = "inspection-cli-token";

const orb = {
  id: "orb-sibling",
  name: "Parser work",
  state: "stopped",
  updatedAt: "2026-08-27T00:00:00.000Z",
  project: {
    id: "project-a",
    name: "Client App",
    repositoryUrl: "https://github.com/example/client",
  },
} as const;

const transcript = {
  v: 1,
  orb,
  session: { id: "session-a", overflow: { native: { privateDuplicate: true } } },
  cursor: "record-1",
  headId: "record-1",
  records: [
    {
      id: "record-1",
      parentId: null,
      timestamp: "2026-08-27T00:00:01.000Z",
      type: "event",
      eventType: "orb.message",
      sender: { orbId: "11111111-1111-4111-8111-111111111111" },
      inboxMessageIds: ["inbox-peer"],
      content: [{ type: "text", text: "Fix parsing" }],
      overflow: { native: { privateDuplicate: true } },
    },
  ],
};
const searchHit = {
  orbId: "orb-sibling",
  sessionId: "session-a",
  recordId: "record-1",
  name: "Parser work",
  projectName: "Client App",
  snippet: "Fix parsing",
  score: 0.125,
  orbUrl: "https://browser.test/orbs/orb-sibling",
};

function runCli(baseUrl: string, args: readonly string[]) {
  return collectCli(args, {
    env: { PATH: process.env.PATH, PI_ORB_CONTROL_PLANE_URL: baseUrl, PI_ORB_RUNTIME_TOKEN: TOKEN },
  });
}

describe("pi-orb inspection CLI entry point", () => {
  let server: Server;
  let baseUrl: string;
  let mode:
    | "ok"
    | "unauthorized"
    | "missing"
    | "unavailable"
    | "malformed"
    | "empty"
    | "invalid_request";
  let searchBody: unknown;

  beforeEach(async () => {
    mode = "ok";
    searchBody = undefined;
    server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      response.setHeader("content-type", "application/json");
      if (mode === "unauthorized") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (mode === "missing") {
        response.statusCode = 404;
        response.end(
          JSON.stringify({
            v: 1,
            error: { code: "not_found", message: "orb not found", retryable: false },
          }),
        );
        return;
      }
      if (request.url === "/runtime/v1/history/search") {
        expect(request.method).toBe("POST");
        expect(request.headers["content-type"]).toBe("application/json");
        let body = "";
        request.on("data", (chunk) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          searchBody = JSON.parse(body);
          if (mode === "unavailable" || mode === "invalid_request") {
            response.statusCode = mode === "unavailable" ? 503 : 400;
            response.end(
              JSON.stringify({
                v: 1,
                error: {
                  code: mode,
                  message: "search refused",
                  retryable: mode === "unavailable",
                },
              }),
            );
          } else if (mode === "malformed") {
            response.end(JSON.stringify({ v: 1, hits: [{}] }));
          } else {
            response.end(
              JSON.stringify({
                v: 1,
                hits: mode === "empty" ? [] : [searchHit],
              }),
            );
          }
        });
        return;
      }
      if (request.url === "/runtime/v1/orb/self") {
        if (mode === "unavailable") {
          response.statusCode = 503;
          response.end(
            JSON.stringify({
              v: 1,
              error: { code: "unavailable", message: "self unavailable", retryable: true },
            }),
          );
          return;
        }
        if (mode === "malformed") {
          response.end(JSON.stringify({ v: 1, orb: { id: "orb-current", extra: true } }));
          return;
        }
        response.end(
          JSON.stringify({
            v: 1,
            orb: {
              id: "orb-current",
              name: "Current",
              url: "https://browser.test/orbs/orb-current",
              createdAt: "2026-10-01T00:00:00.000Z",
            },
            project: orb.project,
            spawnedByOrb: null,
            children: [{ id: "child", name: "Child work", url: "https://browser.test/orbs/child" }],
            previewHost: null,
          }),
        );
        return;
      }
      if (request.url === "/runtime/v1/orbs") {
        response.end(JSON.stringify({ v: 1, currentOrbId: "orb-current", items: [orb] }));
        return;
      }
      if (request.url === "/runtime/v1/orbs/orb-sibling/transcript") {
        response.end(JSON.stringify(transcript));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("searches the current orb by default and prints source metadata", async () => {
    const result = await runCli(baseUrl, ["search", "private query"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(searchBody).toEqual({ query: "private query" });
    for (const text of [
      "orb-sibling",
      "Parser work",
      "Client App",
      "session-a",
      "record-1",
      "Fix parsing",
      "0.125",
      "https://browser.test/orbs/orb-sibling",
    ])
      expect(result.stdout).toContain(text);
    expect(result.stdout).not.toContain("private query");
  });

  it("preserves the result DTO in JSON and sends explicit scope and limit", async () => {
    const result = await runCli(baseUrl, [
      "search",
      "parser",
      "--orb",
      "orb-sibling",
      "--limit",
      "50",
      "--json",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(searchBody).toEqual({ query: "parser", orbId: "orb-sibling", limit: 50 });
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      hits: [searchHit],
    });
  });

  it.each([
    ["unauthorized", 3],
    ["missing", 4],
    ["unavailable", 6],
    ["invalid_request", 2],
    ["malformed", 7],
  ] as const)("reports search %s without stdout", async (failure, code) => {
    mode = failure;
    const result = await runCli(baseUrl, ["search", "private query", "--all"]);
    expect(result).toMatchObject({ code, stdout: "" });
    expect(result.stderr).not.toContain("private query");
  });

  it("distinguishes empty search results from unavailability", async () => {
    mode = "empty";
    expect(await runCli(baseUrl, ["search", "x"])).toEqual({
      code: 0,
      stdout: "No matches.\n",
      stderr: "",
    });
    expect(searchBody).toEqual({ query: "x" });
  });

  it.each([["search"], ["search", "x", "--limit", "51"], ["search", "x", "--project", "--all"]])(
    "rejects malformed search args without issuing HTTP %j",
    async (...args) => {
      expect(await runCli(baseUrl, args)).toMatchObject({ code: 2, stdout: "" });
      expect(searchBody).toBeUndefined();
    },
  );

  it("prints self as a summary or structured JSON", async () => {
    const summary = await runCli(baseUrl, ["self"]);
    expect(summary).toMatchObject({ code: 0, stderr: "" });
    expect(summary.stdout).toContain("Dashboard: https://browser.test/orbs/orb-current");
    expect(summary.stdout).toContain("Child: Child work (child) https://browser.test/orbs/child");
    const json = await runCli(baseUrl, ["self", "--json"]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toMatchObject({
      orb: { id: "orb-current" },
      spawnedByOrb: null,
      children: [{ id: "child", name: "Child work", url: "https://browser.test/orbs/child" }],
      previewHost: null,
    });
    mode = "unauthorized";
    expect(await runCli(baseUrl, ["self"])).toMatchObject({ code: 3, stdout: "" });
  });

  it("rejects malformed self responses and reports unavailable self without stdout", async () => {
    mode = "malformed";
    const malformed = await runCli(baseUrl, ["self", "--json"]);
    expect(malformed).toMatchObject({ code: 7, stdout: "" });
    expect(malformed.stderr).toContain("malformed self response");
    mode = "unavailable";
    const unavailable = await runCli(baseUrl, ["self"]);
    expect(unavailable).toMatchObject({ code: 6, stdout: "" });
    expect(unavailable.stderr).toContain("self unavailable");
  });

  it("prints a successful no-match search as an empty table", async () => {
    const result = await runCli(baseUrl, ["orbs", "does-not-match"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("CURRENT\tORB ID\tNAME\tSTATE\tPROJECT\tREPOSITORY\n");
  });

  it("prints the exact lossless transcript response in JSON mode", async () => {
    const result = await runCli(baseUrl, ["transcript", "orb-sibling", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(transcript);
  });

  it("uses the unauthorized exit class without writing stdout", async () => {
    mode = "unauthorized";
    const result = await runCli(baseUrl, ["orbs"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("control plane rejected this orb's identity");
  });

  it("uses the missing-resource exit class and preserves the server message", async () => {
    mode = "missing";
    const result = await runCli(baseUrl, ["transcript", "missing-orb"]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("pi-orb: orb not found\n");
  });
});

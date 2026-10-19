// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures contain literal template syntax.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { okAsync } from "neverthrow";
import { start } from "./server.ts";
import { PromptService } from "./service.ts";
import { SourceAdapter } from "./source.ts";
import type { Entry, Source } from "./types.ts";

const entry: Entry = {
  id: "example",
  title: "Example",
  category: "Test",
  scope: "Checkout",
  editable: true,
  content: "hello",
  revision: "a".repeat(64),
};
const source: Source = {
  read: () => okAsync(entry),
  save: (_definition, content) => okAsync({ ...entry, content }),
  asset: () => okAsync(Buffer.from("asset")),
};

test("HTTP bearer, exact Host/Origin, body bounds, static allowlist, direct entry response", async (t) => {
  const running = (
    await start({
      port: 0,
      previewHost: "review.example",
      service: new PromptService(source, [
        { ...entry, path: "example.md", selector: { kind: "markdown" } },
      ]),
    })
  )._unsafeUnwrap();
  t.after(() => running.close());
  const port = running.port;
  function call(
    path: string,
    options: {
      method?: string;
      host?: string;
      origin?: string;
      token?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path,
            method: options.method ?? "GET",
            headers: {
              Host: options.host ?? `127.0.0.1:${port}`,
              ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
              ...(options.origin ? { Origin: options.origin } : {}),
              ...options.headers,
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      },
    );
  }
  const auth = { token: running.token };
  assert.equal((await call("/api/prompts")).status, 401);
  assert.equal((await call("/api/prompts", { token: "wrong" })).status, 401);
  assert.equal((await call("/api/prompts", { ...auth, host: `evil.example:${port}` })).status, 403);
  assert.equal(
    (await call("/api/prompts", { ...auth, origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await call("/api/prompts", { ...auth, origin: `http://127.0.0.1:${port}` })).status,
    200,
  );
  assert.equal(
    (
      await call("/api/prompts", {
        ...auth,
        host: `review.example:${port}`,
        origin: `http://review.example:${port}`,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/api/prompts", { ...auth, host: `review.example.evil:${port}` })).status,
    403,
  );
  const put = {
    ...auth,
    method: "PUT",
    body: JSON.stringify({ content: "new 🦊", revision: entry.revision }),
    headers: { "Content-Type": "application/json" },
  };
  assert.equal(
    (
      await call("/api/prompts/example", {
        ...put,
        headers: {},
        origin: `http://127.0.0.1:${port}`,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/api/prompts/example", {
        ...put,
        headers: { "Content-Type": "text/plain" },
        origin: `http://127.0.0.1:${port}`,
      })
    ).status,
    400,
  );
  assert.equal((await call("/api/prompts/example", put)).status, 403);
  assert.equal(
    (await call("/api/prompts/example", { ...put, origin: `http://localhost:${port}` })).status,
    403,
  );
  const saved = await call("/api/prompts/example", { ...put, origin: `http://127.0.0.1:${port}` });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).content, "new 🦊");
  assert.equal(saved.headers["access-control-allow-origin"], undefined);
  const invalid = await call("/api/prompts/example", {
    ...put,
    body: "{",
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).error.code, "invalid_request");
  assert.equal(
    (
      await call("/api/prompts/example", {
        ...put,
        body: "x".repeat(1_048_577 * 7),
        origin: `http://127.0.0.1:${port}`,
      })
    ).status,
    413,
  );
  assert.equal(
    (await call("/api/prompts/%2e%2e%2fsecret", { ...put, origin: `http://127.0.0.1:${port}` }))
      .status,
    404,
  );
  assert.equal((await call("/styles.css")).status, 200);
  assert.equal((await call("/neverthrow.js")).status, 200);
  assert.equal((await call("/fonts/jetbrains-mono-regular-fa06becb7e66.woff2")).status, 200);
  assert.equal((await call("/AGENTS.md")).status, 404);
  assert.equal((await call("/fonts/../../AGENTS.md")).status, 404);
  assert.equal((await call("/?token=wrong")).status, 200);
  assert.equal((await call(`/api/prompts?token=${running.token}`)).status, 401);
});

test("HTTP API exposes and saves prompt prose, never source or selectors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original =
    'import secret from "private-implementation";\nconst prompt = `Hello ${ secret.get({x: 1}) }`;\nexecute(secret);\n';
  await writeFile(join(root, "prompt.ts"), original);
  const running = (
    await start({
      port: 0,
      service: new PromptService(new SourceAdapter(root), [
        {
          id: "greeting",
          title: "Greeting",
          category: "Test",
          scope: "Checkout",
          editable: true,
          path: "prompt.ts",
          selector: {
            kind: "code",
            owner: { kind: "variable", name: "prompt" },
            node: "template",
            variables: ["person"],
          },
        },
      ]),
    })
  )._unsafeUnwrap();
  t.after(() => running.close());
  const url = `http://127.0.0.1:${running.port}`;
  const headers = { Authorization: `Bearer ${running.token}` };
  const response = await fetch(`${url}/api/prompts`, { headers });
  assert.equal(response.status, 200);
  const listed = await response.text();
  for (const privateText of [
    "private-implementation",
    "secret.get",
    "execute(",
    '"selector"',
    '"path"',
  ])
    assert.equal(listed.includes(privateText), false, privateText);
  const entry = JSON.parse(listed).entries[0];
  assert.equal(entry.content, "Hello {{person}}");
  assert.deepEqual(entry.variables, ["person"]);
  const content = "Bonjour ` ${literal}\n{{person}}";
  const savedResponse = await fetch(`${url}/api/prompts/greeting`, {
    method: "PUT",
    headers: { ...headers, Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ content, revision: entry.revision }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.content, content);
  assert.equal("path" in saved, false);
  assert.equal("selector" in saved, false);
  assert.equal(
    await readFile(join(root, "prompt.ts"), "utf8"),
    original.replace("Hello ", "Bonjour \\` \\${literal}\n"),
  );
});

import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { expect, it } from "vitest";
import { applicationHeaders, LoopbackHttpConnection } from "./loopback.ts";

const identityHeaders = {
  "x-goog-iap-jwt-assertion": "assertion",
  "x-goog-authenticated-user-email": "email",
  "x-goog-authenticated-user-id": "identity",
  "x-serverless-authorization": "token",
};
const application = {
  "x-goog-api-key": "application-key",
  "x-goog-request-params": "name=resource",
  authorization: "Bearer application",
  cookie: "app=1",
};

it("preserves Google application headers without platform identity", () => {
  const headers = applicationHeaders({ ...application, ...identityHeaders });
  expect(headers).toMatchObject(application);
  for (const name of Object.keys(identityHeaders)) expect(headers[name]).toBeUndefined();
});

it("HTTP forwards Google application headers in both directions without platform identity", async () => {
  const upstream = createServer((input, output) => {
    output.writeHead(200, { ...application, ...identityHeaders });
    output.end(JSON.stringify(input.headers));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const runtime = createServer((input, output) => {
    new LoopbackHttpConnection(input, output, port, "/").open(
      { touch() {}, release() {} },
      "https://preview.test",
    );
  });
  await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  try {
    const result = await new Promise<{
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const sent = request(
        {
          host: "127.0.0.1",
          port: (runtime.address() as { port: number }).port,
          headers: { ...application, ...identityHeaders },
          agent: false,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.once("end", () => resolve({ headers: response.headers, body }));
          response.once("error", reject);
        },
      );
      sent.once("error", reject);
      sent.end();
    });
    for (const headers of [JSON.parse(result.body), result.headers]) {
      expect(headers).toMatchObject(application);
      for (const name of Object.keys(identityHeaders)) expect(headers[name]).toBeUndefined();
    }
  } finally {
    runtime.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => runtime.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});

it("malformed upstream status yields typed 502, releases ownership and leaves runtime alive", () => {
  const adapter = new URL("./loopback.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import net from 'node:net';
    import http from 'node:http';
    import { LoopbackHttpConnection } from ${JSON.stringify(adapter)};
    let released = 0;
    const upstream = net.createServer(socket => socket.once('data', () =>
      socket.end('HTTP/1.1 099 Strange\\r\\nContent-Length: 0\\r\\n\\r\\n')));
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const runtime = http.createServer((request, response) => {
      if (request.url === '/health') return response.end('ready');
      new LoopbackHttpConnection(request, response, upstream.address().port, '/').open({
        touch() {}, release() { released++; }
      }, 'https://preview.example');
    });
    await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
    const get = path => new Promise((resolve, reject) => {
      http.get({host: '127.0.0.1', port: runtime.address().port, path}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks).toString(), error: response.headers['x-pi-orb-preview-error']}));
        response.on('error', reject);
      }).on('error', reject);
    });
    try {
      const response = await get('/preview');
      const health = await get('/health');
      console.log(JSON.stringify({response, health, released}));
    } finally {
      runtime.closeAllConnections();
      await new Promise(resolve => runtime.close(resolve));
      await new Promise(resolve => upstream.close(resolve));
    }
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const outcome = JSON.parse(result.stdout.trim());
  expect(outcome.response.status).toBe(502);
  expect(outcome.response.error).toBe("upstream_failed");
  expect(JSON.parse(outcome.response.body)).toMatchObject({
    type: "preview_error",
    code: "upstream_failed",
  });
  expect(outcome.health).toEqual({ status: 200, body: "ready" });
  expect(outcome.released).toBe(1);
});

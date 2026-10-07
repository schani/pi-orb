import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

/** Real Vite client/HMR fixture, with owned root and listener. */
export async function startPreviewViteApplication(port = 0) {
  const root = await mkdtemp(join(tmpdir(), "pi-orb-preview-vite-"));
  const module = (value: string) => `export const value = ${JSON.stringify(value)};`;
  await writeFile(
    join(root, "index.html"),
    '<body><script type="module" src="/main.js"></script></body>',
  );
  await writeFile(join(root, "value.js"), module("before"));
  await writeFile(
    join(root, "main.js"),
    `import { value } from '/value.js';
document.body.dataset.value = value;
if (import.meta.hot) import.meta.hot.accept('/value.js', (next) => {
  document.body.dataset.value = next.value;
});`,
  );
  const http = createHttpServer((request, response) => server.middlewares(request, response));
  http.listen(port, "127.0.0.1");
  await once(http, "listening");
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: { server: http }, allowedHosts: true },
  });
  try {
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Vite listener missing");
    return {
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
      update: (value: string) => writeFile(join(root, "value.js"), module(value)),
      close: async () => {
        await server.close();
        http.closeIdleConnections();
        await new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

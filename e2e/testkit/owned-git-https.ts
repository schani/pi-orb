import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

/** Serve one committed Git object/ref set without relaxing the runtime's HTTPS-only transport. */
export async function ownedGitHttps(repository: string, directory: string) {
  const key = join(directory, "git-key.pem"),
    cert = join(directory, "git-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=git-fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  execFileSync("git", ["update-server-info"], { cwd: repository, stdio: "ignore" });
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      const path = new URL(request.url ?? "/", "https://git-fixture").pathname;
      if (
        request.method !== "GET" ||
        !(path === "/info/refs" || path === "/HEAD" || path.startsWith("/objects/"))
      )
        return void response.writeHead(404).end();
      response.setHeader("content-type", "application/octet-stream");
      const file = createReadStream(join(repository, ".git", path));
      file.once("error", () => {
        if (!response.headersSent) response.writeHead(404);
        response.end();
      });
      response.once("close", () => file.destroy());
      file.pipe(response);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Git HTTPS listener");
  return {
    baseUrl: `https://127.0.0.1:${address.port}`,
    cert,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const server = createServer((request, response) => {
  response
    .writeHead(request.url === "/health" && request.headers.host === "app.test" ? 200 : 401)
    .end("{}");
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned address");
  const marker = process.env["PI_ORB_E2E_STARTUP_MARKER"];
  if (marker)
    writeFileSync(
      marker,
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        authDir: process.env["PI_ORB_AUTH_DIR"],
        hostingRoot: process.env["PI_ORB_HOSTING_ROOT"],
      }),
    );
  console.log(`control plane listening on http://127.0.0.1:${address.port}`);
});

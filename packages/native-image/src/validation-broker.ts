export function validationBrokerSource(runtimeToken: string): string {
  return `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const token = ${JSON.stringify(runtimeToken)};
const port = Number(process.env.PI_ORB_VALIDATION_BROKER_PORT ?? "18080");
const marker = process.env.PI_ORB_VALIDATION_BROKER_MARKER ?? "/run/pi-orb-validation-broker-unrecognized";
const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(); });
  request.on("end", () => {
    if (request.headers.authorization !== "Bearer " + token) return json(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/runtime/v1/project-secrets" && body === "") return json(response, 200, { revision: 0, values: {} });
    if (request.method === "GET" && request.url === "/runtime/v1/mcp" && body === "") return json(response, 200, { revision: 0, servers: [] });
    if (request.method === "POST" && request.url === "/runtime/v1/tokens/model") {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      if (!parsed || !["startup", "expiring", "rejected"].includes(parsed.reason) || keys.some((key) => !["reason", "staleGeneration"].includes(key)) || (parsed.staleGeneration !== undefined && typeof parsed.staleGeneration !== "number")) {
        writeFileSync(marker, "invalid model request\\n");
        return json(response, 400, { error: "invalid_request" });
      }
      return json(response, 200, { accessToken: "validation-not-a-credential", accountId: "validation", expiresAt: Date.now() + 3600000, generation: 1 });
    }
    writeFileSync(marker, request.method + " " + request.url + "\\n");
    return json(response, 404, { error: "not_found" });
  });
});
server.listen(port, "127.0.0.1", () => {
  if (process.send) process.send({ port: server.address().port });
});
`;
}

export function validationStartupScript(runtimeToken: string): string {
  const encoded = Buffer.from(validationBrokerSource(runtimeToken)).toString("base64");
  return `#!/bin/bash
set -euo pipefail
echo '${encoded}' | base64 --decode >/run/pi-orb-validation-broker.mjs
chmod 600 /run/pi-orb-validation-broker.mjs
systemd-run --unit=pi-orb-validation-broker --property=Restart=on-failure /usr/local/bin/node /run/pi-orb-validation-broker.mjs
for attempt in $(seq 1 60); do
  if curl --fail --silent -H 'Authorization: Bearer ${runtimeToken}' http://127.0.0.1:18080/runtime/v1/project-secrets >/dev/null; then
    systemctl restart pi-orb-runtime.service
    exit 0
  fi
  sleep 1
done
exit 1
`;
}

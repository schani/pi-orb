// Only this transport is substituted. The provider, reconciler and runtime client stay stock.
import { appendFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { fenceRequest, translateResponse } from "./native-browser-fence.mjs";

const f = globalThis.__nativeBrowserFixture;
if (!f) throw new Error("native browser fixture not initialized");
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export class RestGceApiTransport {
  async request(args) {
    const req = fenceRequest(f, args, globalThis.__nativeBrowserCleanupOnly === true);
    const url = new URL(`https://compute.googleapis.com/compute/v1/${req.path}`);
    if (req.query) url.searchParams.set("filter", req.query);
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const response = await fetch(url, {
      method: req.method,
      headers: { authorization: `Bearer ${token.token ?? ""}`, "content-type": "application/json" },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal: req.signal,
    });
    const result = await response.json().catch(() => ({}));
    appendFileSync(
      f.computeLog,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        collection: req.kind,
        status: response.status,
        errorCode:
          Number.isInteger(result.error?.code) &&
          result.error.code >= 100 &&
          result.error.code <= 599
            ? result.error.code
            : undefined,
      })}\n`,
      { mode: 0o600 },
    );
    return { status: response.status, body: translateResponse(f, req, result) };
  }
}

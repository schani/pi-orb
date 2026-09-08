// Real Compute API and production provider lifecycle; only the ownership
// namespace is adapted. Every request is fenced to the experiment's single orb.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

const root = process.env.NATIVE_INTEGRATION_ROOT;
const fixture = () => JSON.parse(readFileSync(`${root}/fixture.json`));
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
export class RestGceApiTransport {
  async request(args) {
    const f = fixture();
    const prefix = `projects/${f.gcpProject}/zones/${f.zone}/`;
    const imageRead = args.method === "GET" && args.path === f.image;
    assert(imageRead || args.path.startsWith(prefix), "foreign project/zone");
    const url = new URL(`https://compute.googleapis.com/compute/v1/${args.path}`);
    const relative = imageRead ? "images/accepted" : url.pathname.split(prefix)[1];
    const [kind, name, action] = relative.split("/");
    const instancePrefix = `pi-orb-${f.orbId}`;
    const instanceOwned = (n) =>
      n === instancePrefix ||
      (n.startsWith(`${instancePrefix}-i`) && /^\d+$/.test(n.slice(instancePrefix.length + 2)));
    if (kind === "instances") {
      if (name) assert(instanceOwned(name), "foreign instance");
      else if (args.method === "GET")
        url.searchParams.set("filter", `labels.pi-orb-integration-orb-id = "${f.orbId}"`);
      else
        assert(args.method === "POST" && instanceOwned(args.body.name), "foreign instance insert");
    } else if (kind === "disks") {
      assert((name ?? args.body?.name) === `pi-orb-data-${f.orbId}`, "foreign disk");
    } else if (kind === "operations") {
      assert(args.method === "POST" && action === "wait", "operation mutation");
    } else assert(imageRead, "unsupported Compute collection");
    const body = args.body === undefined ? undefined : structuredClone(args.body);
    if (args.method === "POST" && !name && ["instances", "disks"].includes(kind)) {
      assert.equal(body.labels["pi-orb-orb-id"], f.orbId);
      body.labels["pi-orb-experiment"] = "native-vm-integration-0905";
    }
    if (kind === "instances" && args.method === "POST" && !name) {
      body.labels["pi-orb-integration-orb-id"] = body.labels["pi-orb-orb-id"];
      delete body.labels["pi-orb-orb-id"];
      body.tags = { items: ["pi-orb-native-integration-orb"] };
    }
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const response = await fetch(url, {
      method: args.method,
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: args.signal,
    });
    const result = await response.json();
    appendFileSync(
      `${root}/compute-requests.jsonl`,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: args.method,
        path: url.pathname + url.search,
        status: response.status,
        error: response.ok ? undefined : result.error,
      })}\n`,
    );
    if (kind === "instances") {
      for (const item of name ? [result] : (result.items ?? [])) {
        if (item.labels?.["pi-orb-integration-orb-id"] === f.orbId)
          item.labels["pi-orb-orb-id"] = f.orbId;
      }
    }
    if (kind === "instances" && !name && args.method === "GET")
      assert((result.items ?? []).every((x) => x.labels?.["pi-orb-orb-id"] === f.orbId));
    return { status: response.status, body: result };
  }
}

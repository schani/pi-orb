import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  FetchTailscaleApiTransport,
  HttpTailscaleAuthKeyMinter,
} from "../../apps/control-plane/src/adapters/tailscale/client.ts";

const project = "playground-dev-6ae7";
const service = JSON.parse(
  execFileSync(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      "pi-orb",
      `--project=${project}`,
      "--region=us-central1",
      "--format=json",
    ],
    { encoding: "utf8" },
  ),
);
const env = Object.fromEntries(
  service.spec.template.spec.containers[0].env.map((x) => [x.name, x.value]),
);
const secret = execFileSync(
  "gcloud",
  [
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret=pi-orb-tailscale-oauth-client-secret",
    `--project=${project}`,
  ],
  { encoding: "utf8" },
).trim();
const minter = new HttpTailscaleAuthKeyMinter(new FetchTailscaleApiTransport(), {
  clientId: env.PI_ORB_TAILSCALE_OAUTH_CLIENT_ID,
  clientSecret: secret,
});
const fixture = JSON.parse(readFileSync(".context/native-vm/fixture.json", "utf8"));
if (process.argv[2] === "cleanup") {
  const result = await minter.cleanupOrb(fixture.orbId, AbortSignal.timeout(30000));
  if (result.isErr()) {
    console.error(result.error.code);
    process.exitCode = 1;
  } else console.log("experiment tailnet identity removed");
} else {
  const result = await minter.mintAuthKey(fixture.orbId, 0, AbortSignal.timeout(30000));
  if (result.isErr()) {
    console.error(result.error.code);
    process.exitCode = 1;
  } else {
    const config = JSON.parse(readFileSync(".context/native-vm/config.json", "utf8"));
    Object.assign(config, {
      PI_ORB_TAILSCALE_AUTH_KEY: result.value,
      PI_ORB_TAILSCALE_HOSTNAME: `pi-orb-${fixture.orbId}`,
      PI_ORB_PREVIEW_HOST: `pi-orb-${fixture.orbId}.${env.PI_ORB_TAILSCALE_TAILNET_DNS_NAME}`,
    });
    writeFileSync(".context/native-vm/config.json", JSON.stringify(config), { mode: 0o600 });
    console.log("experiment tailnet key minted");
  }
}

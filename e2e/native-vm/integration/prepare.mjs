import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createFakeSession } from "../../harness.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const cpDocument = JSON.parse(readFileSync(`${root}/cp.json`));
const cp = Array.isArray(cpDocument) ? cpDocument[0] : cpDocument;
const tool = {
  match: { userMessage: { regex: "native VM tool check" } },
  steps: [
    {
      type: "toolCall",
      name: "bash",
      arguments: {
        command:
          "sudo systemctl start docker && docker run --rm alpine:3.22 echo NATIVE_VM_TOOL_OK",
      },
    },
    { type: "stop", status: "completed" },
  ],
};
const result = {
  match: { toolResultContains: { regex: "NATIVE_VM_TOOL_OK" } },
  steps: [
    { type: "text", content: "Native VM tool succeeded." },
    { type: "stop", status: "completed" },
  ],
};
const summary = {
  match: { userMessage: { regex: "desktop-notification" } },
  steps: [
    { type: "text", content: "Started Docker on demand." },
    { type: "stop", status: "completed" },
  ],
};
const fake = await createFakeSession("native-vm-integration-model", {
  auth: { accountId: "acct_native_integration", device: { manualApprove: true } },
  model: { rules: Array.from({ length: 12 }, () => [tool, result, summary]).flat() },
});
const nameFake = await createFakeSession("native-vm-integration-naming", {
  auth: { accountId: "acct_native_integration" },
  model: {
    rules: Array.from({ length: 12 }, () => ({
      match: { default: true },
      steps: [
        { type: "text", content: "Native integration" },
        { type: "stop", status: "completed" },
      ],
    })),
  },
});
const fixture = {
  orbId: randomUUID(),
  projectId: randomUUID(),
  gcpProject: "playground-dev-6ae7",
  zone: "us-central1-a",
  image: process.env.NATIVE_IMAGE_RESOURCE ?? "",
  imageId: process.env.NATIVE_IMAGE_ID ?? "",
  generation: 1,
  brokerUrl: `http://${cp.networkInterfaces[0].networkIP}:18100`,
  repositoryUrl: "https://github.com/octocat/Hello-World",
  wifServiceAccount: process.env.NATIVE_WIF_SERVICE_ACCOUNT ?? "",
  wifProvider: process.env.NATIVE_WIF_PROVIDER ?? "",
  fake,
  nameFake,
};
if (!fixture.image || !fixture.imageId || !fixture.wifServiceAccount || !fixture.wifProvider)
  throw new Error("native image and workload identity configuration are required");
writeFileSync(`${root}/fixture.json`, JSON.stringify(fixture), { mode: 0o600 });
const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
writeFileSync(
  `${root}/github-credential.json`,
  JSON.stringify({
    access: token,
    refresh: "",
    accountId: "schani",
    expiresAt: Date.now() + 6 * 3600000,
  }),
  { mode: 0o600 },
);
const deployed = JSON.parse(
  execFileSync(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      "pi-orb",
      "--project=playground-dev-6ae7",
      "--region=us-central1",
      "--format=json",
    ],
    { encoding: "utf8" },
  ),
);
const env = Object.fromEntries(
  deployed.spec.template.spec.containers[0].env.map((x) => [x.name, x.value]),
);
const tsSecret = execFileSync(
  "gcloud",
  [
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret=pi-orb-tailscale-oauth-client-secret",
    "--project=playground-dev-6ae7",
  ],
  { encoding: "utf8" },
).trim();
writeFileSync(
  `${root}/tailscale.json`,
  JSON.stringify({
    clientId: env.PI_ORB_TAILSCALE_OAUTH_CLIENT_ID,
    clientSecret: tsSecret,
    tailnetDnsName: env.PI_ORB_TAILSCALE_TAILNET_DNS_NAME,
  }),
  { mode: 0o600 },
);
console.log("isolated integration fixture prepared");

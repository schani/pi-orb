import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createFakeSession } from "../harness.ts";

const tool = {
  match: { userMessage: { regex: "native VM tool check" } },
  steps: [
    {
      type: "toolCall",
      name: "bash",
      arguments: {
        command:
          'printf NATIVE_VM_TOOL_OK; id -u; sudo systemctl start docker; docker version --format "{{.Server.Version}}"',
      },
    },
    { type: "usage", input_tokens: 100, output_tokens: 20 },
    { type: "stop", status: "completed" },
  ],
};
const result = {
  match: { toolResultContains: { regex: "NATIVE_VM_TOOL_OK" } },
  steps: [
    { type: "text", content: "Native VM tool succeeded." },
    { type: "usage", input_tokens: 100, output_tokens: 20 },
    { type: "stop", status: "completed" },
  ],
};
const summary = {
  match: { userMessage: { regex: "desktop-notification" } },
  steps: [
    { type: "text", content: "Verified native VM Docker tooling." },
    { type: "stop", status: "completed" },
  ],
};
// Each turn consumes tool, continuation, and summary rules in order. Naming
// uses a separate session so its concurrent request cannot consume those rules.
const fake = await createFakeSession("native-vm-model", {
  auth: { accountId: "acct_native_vm_spike", device: { manualApprove: true } },
  model: { rules: Array.from({ length: 8 }, () => [tool, result, summary]).flat() },
});
const nameFake = await createFakeSession("native-vm-naming", {
  auth: { accountId: "acct_native_vm_spike" },
  model: {
    rules: Array.from({ length: 8 }, () => ({
      match: { default: true },
      steps: [
        { type: "text", content: "Native VM experiment" },
        { type: "stop", status: "completed" },
      ],
    })),
  },
});
const fixture = {
  orbId: randomUUID(),
  projectId: randomUUID(),
  token: randomBytes(32).toString("hex"),
  instance: `${process.env["NATIVE_VM_PREFIX"] ?? "pi-orb-vm-spike-riga-0905"}-a`,
  runtimeUrl: "http://127.0.0.1:18180",
  fake,
  nameFake,
};
writeFileSync(".context/native-vm/fixture.json", JSON.stringify(fixture), { mode: 0o600 });
writeFileSync(
  ".context/native-vm/config.json",
  JSON.stringify({
    PI_ORB_ID: fixture.orbId,
    PI_ORB_HOST_INCARNATION: "0",
    PI_ORB_RUNTIME_TOKEN: fixture.token,
    PI_ORB_CONTROL_PLANE_URL: "http://127.0.0.1:18100",
    PI_ORB_REPOSITORY_URL: "https://github.com/schani/pi-orb",
    PI_ORB_FAKE_OPENAI_OAUTH_URL: fake.oauthBaseUrl,
    PI_ORB_FAKE_OPENAI_INFERENCE_URL: fake.inferenceBaseUrl,
    PI_OFFLINE: "1",
  }),
  { mode: 0o600 },
);
console.log("fixture prepared");

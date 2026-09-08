import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixture = JSON.parse(readFileSync(".context/native-vm/fixture.json", "utf8"));
Object.assign(process.env, {
  NATIVE_VM_FIXTURE: resolve(".context/native-vm/fixture.json"),
  PI_ORB_DATABASE_KIND: "pglite",
  PI_ORB_PGLITE_PATH: resolve(`.context/native-vm/control-plane-${fixture.epoch ?? "1"}.pglite`),
  PI_ORB_AUTH_DIR: resolve(`.context/native-vm/auth-${fixture.epoch ?? "1"}`),
  PORT: "18100",
  PI_ORB_HOST_PROVIDER: "docker",
  PI_ORB_WEB_DIST: resolve("apps/web/dist"),
  PI_ORB_NAME_INFERENCE_URL: fixture.nameFake?.inferenceBaseUrl,
  PI_ORB_FAKE_OPENAI_OAUTH_URL: fixture.fake.oauthBaseUrl,
  PI_ORB_FAKE_OPENAI_INFERENCE_URL: fixture.fake.inferenceBaseUrl,
});
await import("./control-plane.mjs");

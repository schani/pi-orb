import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FetchTailscaleApiTransport,
  HttpTailscaleAuthKeyMinter,
} from "../../../apps/control-plane/src/adapters/tailscale/client.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const ts = JSON.parse(readFileSync(`${root}/tailscale.json`));
const result = await new HttpTailscaleAuthKeyMinter(
  new FetchTailscaleApiTransport(),
  ts,
).cleanupOrb(f.orbId, AbortSignal.timeout(30000));
assert(result.isOk(), result.isErr() ? result.error.code : "");
console.log("TEST_ORB_TAILNET_CLEANED");

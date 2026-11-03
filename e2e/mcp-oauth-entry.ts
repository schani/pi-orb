// Test-only composition: production has no environment switch to weaken OAuth egress.
import { SdkMcpOAuth } from "../apps/control-plane/src/adapters/mcp-oauth.ts";
import { main } from "../apps/control-plane/src/main.ts";
import { localResourceSource } from "./testkit/resource-source-fixture.ts";

const origin = process.env["PI_ORB_E2E_MCP_ORIGIN"];
if (!origin) throw new Error("Test-owned MCP origin required");
const allowed = (url: string) => new URL(url).origin === origin;
const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];
void main({
  ...(repository
    ? {
        resourceSource: localResourceSource(
          repository,
          undefined,
          process.env["PI_ORB_E2E_RESOURCE_URL"],
        ),
      }
    : {}),
  mcpOAuthProtocol: (callback) =>
    new SdkMcpOAuth(
      callback,
      (input, init) => {
        if (!allowed(String(input)))
          return Promise.reject(new Error("Non-fixture OAuth egress rejected"));
        return fetch(input, { ...init, redirect: "error" });
      },
      allowed,
    ),
});

# Pi + OpenAI Codex end-to-end testing with a mock service

## Conclusion

Yes. Pi can use the mock service for both parts of the flow:

| Concern | Pi configuration | Mock endpoint |
|---|---|---|
| OAuth login and token refresh | Override the built-in `openai-codex` provider with a custom `oauth` implementation | Endpoints chosen by the test, such as `/oauth/device/code`, `/oauth/token`, and `/oauth/refresh` |
| Codex inference | Set the same provider's `baseUrl` to the mock origin | Pi sends requests to `${baseUrl}/codex/responses` |

This is a supported provider override, not fetch monkey-patching, DNS rewriting, or another test-only interception trick.

The important distinction is that Pi's **built-in** OpenAI Codex OAuth implementation hard-codes `https://auth.openai.com`. Merely changing `baseUrl` or `models.json` does not redirect OAuth. Supplying a custom `oauth` implementation through `registerProvider()` replaces that built-in OAuth flow, while `baseUrl` redirects inference.

## Recommended architecture

Override the existing provider ID, `openai-codex`, rather than creating a different provider ID:

```ts
modelRuntime.registerProvider("openai-codex", {
  name: "OpenAI Codex (E2E mock)",
  baseUrl: mockOrigin,
  oauth: mockCodexOAuth(mockOrigin),
});
```

Because this registration does not provide a `models` array:

- Pi preserves the built-in OpenAI Codex model catalog.
- Pi preserves the built-in `openai-codex-responses` serializer and stream parser.
- The custom `oauth` object replaces the built-in OpenAI OAuth implementation.
- The custom `baseUrl` replaces `https://chatgpt.com/backend-api` for inference.

After registration, refresh and resolve the model from the configured runtime so the selected model contains the mock base URL:

```ts
await modelRuntime.refresh({ allowNetwork: false });

const model = modelRuntime.getModel("openai-codex", "gpt-5.5");
if (!model) throw new Error("OpenAI Codex test model is unavailable");
```

The expected inference URL is:

```text
POST <mockOrigin>/codex/responses
```

## SDK setup

Use in-memory credentials, settings, and sessions so the test is isolated from the developer's Pi configuration:

```ts
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const credentials = new InMemoryCredentialStore();

const modelRuntime = await ModelRuntime.create({
  credentials,
  modelsPath: null,
  allowModelNetwork: false,
});

modelRuntime.registerProvider("openai-codex", {
  name: "OpenAI Codex (E2E mock)",
  baseUrl: mockOrigin,
  oauth: mockCodexOAuth(mockOrigin),
});

// Exercise OAuth through Pi. The custom provider stores the returned
// credential in the injected InMemoryCredentialStore.
await modelRuntime.login("openai-codex", "oauth", {
  notify(event) {
    observedAuthEvents.push(event);
  },
  async prompt(prompt) {
    return testDriver.answerAuthPrompt(prompt);
  },
});

await modelRuntime.refresh({ allowNetwork: false });

const model = modelRuntime.getModel("openai-codex", "gpt-5.5");
if (!model) throw new Error("OpenAI Codex test model is unavailable");

const settingsManager = SettingsManager.inMemory({
  transport: "sse",
  compaction: { enabled: false },
  retry: { enabled: false },
});

const { session } = await createAgentSession({
  model,
  modelRuntime,
  settingsManager,
  sessionManager: SessionManager.inMemory(),
  // Supply the test's ResourceLoader and desired tool configuration here.
});

try {
  await session.prompt("Perform the E2E scenario");
} finally {
  session.dispose();
}
```

`transport: "sse"` is an official Pi setting and keeps the first E2E implementation deterministic. Add separate WebSocket coverage if the application intends to use Codex's WebSocket transport.

The provider can also be registered from a documented inline extension via `DefaultResourceLoader.extensionFactories`. Direct registration on the SDK's `ModelRuntime` is simpler when the embedding application owns runtime construction.

## Custom OAuth implementation

The custom OAuth functions own all auth URLs. Therefore they must use `mockOrigin` and must not call OpenAI hosts.

A headless device-code flow is convenient for automated E2E tests:

```ts
function mockCodexOAuth(mockOrigin: string) {
  return {
    name: "Mock OpenAI Codex OAuth",

    async login(callbacks) {
      const device = await fetch(`${mockOrigin}/oauth/device/code`, {
        method: "POST",
      }).then(assertOkJson);

      callbacks.onDeviceCode({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        intervalSeconds: device.interval,
        expiresInSeconds: device.expires_in,
      });

      // Poll the mock until the test driver authorizes the device code.
      const token = await pollMockDeviceToken(mockOrigin, device, callbacks);

      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
      };
    },

    async refreshToken(credentials) {
      const token = await fetch(`${mockOrigin}/oauth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: credentials.refresh }),
      }).then(assertOkJson);

      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
      };
    },

    getApiKey(credentials) {
      return credentials.access;
    },
  };
}
```

A browser authorization-code flow is also possible. The custom `login` function should call `callbacks.onAuth({ url })`, handle the callback or pasted callback URL, exchange the code against the mock token endpoint, and return the same credential shape.

Pi's compatibility OAuth API does not automatically invent the mock flow: the custom implementation remains responsible for authorization-code/device-code polling and token exchange. Pi provides the UI-neutral callbacks and persists the resulting credential.

## Access-token requirement

The built-in Codex inference implementation extracts the ChatGPT account ID from the OAuth access token and sends it as the `chatgpt-account-id` header. The mock OAuth service must therefore issue a JWT containing:

```json
{
  "https://api.openai.com/auth": {
    "chatgpt_account_id": "account-e2e"
  }
}
```

The mock may sign this JWT with a test key. The important behavior is that:

1. Pi can decode the claim.
2. The inference request contains `Authorization: Bearer <access-token>`.
3. The inference request contains `chatgpt-account-id: account-e2e`.
4. The mock service accepts the token it issued.

To test refresh, return a short-lived initial token, advance the test clock or wait for expiry, and assert that the custom `refreshToken` implementation calls the mock refresh endpoint before the next inference request.

## Mock inference surface

At minimum, the mock Codex service should support:

- `POST /codex/responses`
- OpenAI Responses-style SSE events
- Text output
- Reasoning output if used by the selected scenario
- Function/tool calls and the following request containing tool results
- Terminal `response.completed`, `response.incomplete`, and error behavior
- Usage fields used by Pi
- Request cancellation for abort coverage

Pi may zstd-compress Codex SSE request bodies when Node provides zstd support. A mock that inspects request JSON should decode `Content-Encoding: zstd` as well as uncompressed JSON.

If the test uses `transport: "auto"` or a WebSocket mode, the mock must additionally implement the Codex WebSocket protocol at the WebSocket form of the same `/codex/responses` URL. Otherwise, configure `transport: "sse"` explicitly.

## Network-isolation assertions

The E2E harness should fail on any unexpected outbound host. Expected traffic should be limited to the mock origin.

Use all of the following where applicable:

- `ModelRuntime.create({ allowModelNetwork: false, modelsPath: null })`
- In-memory credentials and settings
- An in-memory session
- A controlled `ResourceLoader` with unrelated extensions and resources disabled
- `PI_OFFLINE=1` as an additional guard when launching Pi through its CLI rather than embedding the SDK
- A test-level outbound-network deny rule that allows only the mock listener

Assert specifically that no request is made to:

- `auth.openai.com`
- `chatgpt.com`
- `api.openai.com`
- Pi model-catalog or update endpoints

`api.openai.com` still appears as the namespace of the JWT claim; that string in token data is not a network destination.

## Suggested E2E scenarios

1. **OAuth login and inference**
   - Start with an empty `InMemoryCredentialStore`.
   - Complete mock OAuth through `modelRuntime.login()`.
   - Prompt the agent.
   - Assert OAuth and inference requests reached only the mock.

2. **Token refresh**
   - Issue an expired or short-lived access token.
   - Prompt the agent.
   - Assert the mock refresh endpoint was called and the new token was used.

3. **Tool round trip**
   - Return a function call from `/codex/responses`.
   - Let Pi execute the tool.
   - Assert the next mocked inference request contains the tool result.

4. **OAuth failure**
   - Return `access_denied` or an invalid token response.
   - Assert Pi reports login failure and does not invoke inference.

5. **Inference failure and abort**
   - Return representative Codex errors and a delayed stream.
   - Assert error mapping and cancellation behavior.

## Non-recommended alternatives

Do not redirect the built-in OAuth flow by monkey-patching global `fetch`, changing DNS, intercepting TLS, or modifying installed Pi files. Those approaches are unnecessary because provider OAuth and inference endpoints have supported injection points.

## Re-confirmation

With the `openai-codex` provider override in place:

- **OAuth:** the custom provider's `login` and `refreshToken` functions communicate with the mock OAuth service.
- **Inference:** the provider's `baseUrl` makes Pi communicate with the mock Codex Responses service.
- **Codex behavior:** Pi continues using its built-in Codex request serialization, response streaming, tool handling, and model definitions.
- **Production isolation:** neither `auth.openai.com` nor `chatgpt.com` needs to be contacted.

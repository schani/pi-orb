import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "neverthrow";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const boolean = (value: unknown) => (typeof value === "boolean" ? value : null);
const id = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const timestamp = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? value
    : null;
const member = (value: unknown, allowed: string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : null;

function errorCategory(error: unknown) {
  const name = object(error)["name"];
  return name === "TimeoutError"
    ? "timeout"
    : name === "AbortError"
      ? "aborted"
      : name === "SyntaxError"
        ? "decode"
        : name === "TypeError"
          ? "transport"
          : "unknown";
}

const stopReason = (value: unknown) =>
  member(value, ["stop", "length", "toolUse", "error", "aborted"]);
const present = (value: unknown) => typeof value === "string" && value.length > 0;

function authPathCategory(value: unknown) {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path.endsWith("/api/accounts/deviceauth/usercode")) return "deviceauth/usercode";
  if (path.endsWith("/api/accounts/deviceauth/token")) return "deviceauth/token";
  if (path.endsWith("/oauth/token")) return "oauth/token";
  return null;
}

function modelRequest(row: Record<string, unknown>) {
  const raw = row["body"];
  const body = object(
    typeof raw === "string"
      ? Result.fromThrowable(
          () => JSON.parse(raw) as unknown,
          () => "decode" as const,
        )().unwrapOr(null)
      : raw,
  );
  return {
    model: body["model"] === "gpt-6-luna" ? "luna" : body["model"] === "gpt-6.1-sol" ? "sol" : null,
    encoding: member(object(row["headers"])["content-encoding"], ["zstd", "gzip", "br"]),
    inputCount: Array.isArray(body["input"]) ? body["input"].length : null,
  };
}

export function failureRequests(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .filter((row) => ["model", "auth"].includes(String(object(row)["surface"])))
    .slice(-80)
    .map((value) => {
      const row = object(value);
      const events = (Array.isArray(row["events"]) ? row["events"] : []).slice(-80);
      return {
        surface: member(row["surface"], ["model", "auth"]),
        method: member(row["method"], ["GET", "POST"]),
        pathCategory: row["surface"] === "auth" ? authPathCategory(row["path"]) : null,
        id: number(row["id"]),
        status: number(row["status"]),
        matchedRuleIndex: number(row["matchedRuleIndex"]),
        createdAt: timestamp(row["createdAt"]),
        stopReason: stopReason(row["stopReason"]),
        aborted: boolean(row["aborted"]),
        finalized: boolean(row["finalized"]),
        ...(row["surface"] === "model"
          ? {
              modelRequest: modelRequest(row),
              modelErrors: events
                .filter((event) => object(event)["kind"] === "response")
                .map((event) =>
                  member(object(object(event)["body"])["error"], [
                    "no_matching_rule",
                    "invalid_body",
                    "unknown_session",
                  ]),
                ),
            }
          : {}),
        ...(row["surface"] === "auth"
          ? {
              authResponses: events
                .filter((event) => object(event)["kind"] === "response")
                .map((event) => {
                  const response = object(event);
                  const body = object(response["body"]);
                  const code = object(body["error"])["code"];
                  return {
                    status: number(response["status"]),
                    deviceAuthIdPresent: present(body["device_auth_id"]),
                    userCodePresent: present(body["user_code"]),
                    authorizationCodePresent: present(body["authorization_code"]),
                    codeVerifierPresent: present(body["code_verifier"]),
                    accessTokenPresent: present(body["access_token"]),
                    refreshTokenPresent: present(body["refresh_token"]),
                    authorizationPending: code === "deviceauth_authorization_pending",
                    slowDown: code === "slow_down",
                  };
                }),
            }
          : {}),
        eventTypes: events.map((event) =>
          member(object(event)["type"] ?? object(event)["kind"], [
            "response",
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.output_item.done",
            "response.content_part.added",
            "response.content_part.done",
            "response.output_text.delta",
            "response.output_text.done",
            "response.completed",
            "response.failed",
            "response.incomplete",
            "error",
          ]),
        ),
      };
    });
}

export function failureHistory(value: unknown) {
  const snapshot = object(value);
  const records = Array.isArray(snapshot["records"]) ? snapshot["records"] : [];
  return {
    cursor: id(snapshot["cursor"]),
    headId: id(snapshot["headId"]),
    recordCount: records.length,
    sessionId: id(object(snapshot["session"])["id"]),
    assistants: records
      .slice(-80)
      .filter((value) => {
        const record = object(value);
        return record["type"] === "message" && record["role"] === "assistant";
      })
      .map((value) => {
        const record = object(value);
        return {
          recordId: id(record["id"]),
          parentId: id(record["parentId"]),
          finishReason: stopReason(record["finishReason"]),
        };
      }),
    tools: records
      .slice(-80)
      .flatMap((value) => {
        const record = object(value);
        return (Array.isArray(record["content"]) ? record["content"] : [])
          .filter((value) => ["tool_call", "tool_result"].includes(String(object(value)["type"])))
          .slice(-20)
          .map((value) => {
            const block = object(value);
            return {
              recordId: id(record["id"]),
              parentId: id(record["parentId"]),
              timestamp: timestamp(record["timestamp"]),
              type: block["type"],
              callId: id(block["callId"]),
              name: member(block["name"], ["bash", "read", "write", "edit", "subagent"]),
              isError: boolean(block["isError"]),
            };
          });
      })
      .slice(-80),
  };
}

/** Bounded in-memory metadata; persisted only by a test's failure catch. */
export class FailureEvidence {
  readonly observations: Record<string, unknown>[] = [];
  target: string;
  constructor(target: string) {
    this.target = target;
  }

  async probe<T extends { status: number; body: Record<string, unknown> }>(
    resource: "orb" | "history" | "health",
    probe: () => Promise<T>,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const target = this.target;
    try {
      const response = await probe();
      const body = response.body;
      const action = object(body["actionRequired"]);
      this.record({
        target,
        resource,
        startedAt,
        completedAt: new Date().toISOString(),
        status: response.status,
        runtimeStatus: member(body["status"], ["initializing", "ready", "failed"]),
        runtimeInstanceId: id(body["runtimeInstanceId"]),
        runtimePhase: member(body["phase"], [
          "booting",
          "cloning",
          "setup_running",
          "checking_project_secrets",
          "loading_session",
          "checking_auth",
        ]),
        state: member(body["state"], [
          "creating",
          "starting",
          "running",
          "stopping",
          "stopped",
          "failed",
          "deleting",
          "archiving",
          "archived",
        ]),
        activity: member(body["activity"], ["idle", "busy"]),
        stateVersion: number(body["stateVersion"]),
        stateChangedAt: timestamp(body["stateChangedAt"]),
        healthDetail: member(object(body["stateDetail"])["type"], [
          "waiting_for_runtime",
          "running_setup",
          "setup_failed",
          "discarding_failed_compute",
          "replacing_stale_compute",
          "draining_history",
        ]),
        userCodePresent: typeof action["userCode"] === "string" && action["userCode"].length > 0,
        verificationUriPresent:
          typeof action["verificationUri"] === "string" && action["verificationUri"].length > 0,
        ...(resource === "history" ? failureHistory(body) : {}),
      });
      return response;
    } catch (error) {
      this.record({
        target,
        resource,
        startedAt,
        completedAt: new Date().toISOString(),
        status: null,
        errorCategory: errorCategory(error),
      });
      throw error;
    }
  }

  private record(row: Record<string, unknown>) {
    this.observations.push(row);
    if (this.observations.length > 80) this.observations.shift();
  }

  async save(caseName: "profile-login" | "full-slice-upload", requests: () => Promise<unknown>) {
    let requestLedger: unknown;
    try {
      requestLedger = failureRequests(await requests());
    } catch (error) {
      requestLedger = { errorCategory: errorCategory(error) };
    }
    const directory = join(import.meta.dirname, "../../test-failures", caseName);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "failure.json"),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          target: this.target,
          observations: this.observations,
          requestLedger,
        },
        null,
        2,
      ),
    );
  }
}

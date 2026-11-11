import { ORB_SPAWN_UUID, OrbCleanupErrorSchema, type OrbCleanupRequest } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { type BrokerEnv, readBrokerEnv } from "../broker/endpoint.ts";

type CleanupFailure = {
  readonly type: "cleanup_failure";
  readonly code:
    | "invalid_request"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "unavailable"
    | "internal"
    | "unknown_outcome";
  readonly message: string;
};

function cleanupExitCode(failure: CleanupFailure): number {
  switch (failure.code) {
    case "invalid_request":
      return 2;
    case "unauthorized":
      return 3;
    case "not_found":
    case "conflict":
      return 4;
    case "unavailable":
    case "unknown_outcome":
      return 6;
    case "internal":
      return 7;
  }
}

export function cleanupCommand<S extends TSchema>(
  action: "archive" | "delete",
  path: string,
  responseSchema: S,
) {
  const usage = `usage: pi-orb ${action} <self|orb-id>`;
  function parse(args: readonly string[]): Result<OrbCleanupRequest, CleanupFailure> {
    const [target] = args;
    if (args.length === 1 && target === "self") return ok({ self: true });
    if (args.length === 1 && target !== undefined && ORB_SPAWN_UUID.test(target))
      return ok({ orbId: target.toLowerCase() });
    return err({ type: "cleanup_failure", code: "invalid_request", message: usage });
  }

  /** A transport failure after submission cannot establish whether intent committed. */
  function request(
    env: BrokerEnv,
    target: OrbCleanupRequest,
  ): ResultAsync<Static<S>, CleanupFailure> {
    const targetLabel = "self" in target ? "this orb" : `orb ${target.orbId}`;
    const unknown = (): CleanupFailure => ({
      type: "cleanup_failure",
      code: "unknown_outcome",
      message: `${action === "archive" ? "archive" : "deletion"} acceptance is unknown; inspect ${targetLabel} in the dashboard`,
    });
    return ResultAsync.fromThrowable(async () => {
      const response = await fetch(`${env.controlPlaneUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(target),
        signal: AbortSignal.timeout(3_000),
      });
      const payload: unknown = await response.json();
      return { status: response.status, payload };
    }, unknown)().andThen<Static<S>, CleanupFailure>(({ status, payload }) => {
      if (status === 202 && Check(responseSchema, payload)) return ok(payload);
      if (status !== 202 && Check(OrbCleanupErrorSchema, payload)) {
        return err({
          type: "cleanup_failure" as const,
          code: payload.error.code,
          message: payload.error.message,
        });
      }
      return err(unknown());
    });
  }

  async function run(): Promise<void> {
    const parsed = parse(process.argv.slice(2));
    const env = readBrokerEnv(process.env);
    if (parsed.isErr()) {
      process.stderr.write(`pi-orb: ${parsed.error.message}\n`);
      process.exitCode = cleanupExitCode(parsed.error);
    } else if (env === null) {
      process.stderr.write(
        `pi-orb: orb runtime environment missing (not inside an orb?)\n${usage}\n`,
      );
      process.exitCode = 2;
    } else {
      const result = await request(env, parsed.value);
      if (result.isErr()) {
        process.stderr.write(`pi-orb: ${result.error.message}\n`);
        process.exitCode = cleanupExitCode(result.error);
      } else if (action === "archive") {
        process.stdout.write(
          "self" in parsed.value
            ? "Archive requested. This turn may finish; workspace files will be permanently deleted and the conversation retained.\n"
            : `Archive requested for orb ${parsed.value.orbId}. Its workspace files will be permanently deleted and the conversation retained.\n`,
        );
      } else {
        process.stdout.write(
          "self" in parsed.value
            ? "Deletion requested. Workspace, conversation, and hosted files will be permanently deleted; this turn may be interrupted.\n"
            : `Deletion requested for orb ${parsed.value.orbId}. Workspace, conversation, and hosted files will be permanently deleted.\n`,
        );
      }
    }
  }
  return { usage, parse, request, run };
}

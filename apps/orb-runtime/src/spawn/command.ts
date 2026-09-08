import {
  ORB_SPAWN_MAX_BYTES,
  ORB_SPAWN_UUID,
  OrbSpawnErrorSchema,
  type OrbSpawnRequest,
  type OrbSpawnResponse,
  OrbSpawnResponseSchema,
} from "@pi-orb/protocol";
import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const SPAWN_USAGE =
  "usage: pi-orb spawn (--prompt <text> | --prompt-file <path|->) [--name <name>] [--id <uuid>] [--json]";
export type SpawnFailure = {
  readonly type: "spawn_failure";
  readonly message: string;
  readonly exitCode: number;
};
export type SpawnArgs = {
  source: { text: string } | { file: string };
  id?: string;
  name?: string;
  json: boolean;
};
const invalid = (message: string): SpawnFailure => ({
  type: "spawn_failure",
  message,
  exitCode: 2,
});

export function parseSpawnArgs(args: readonly string[]): Result<SpawnArgs, SpawnFailure> {
  let source: SpawnArgs["source"] | undefined;
  let id: string | undefined;
  let name: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (seen.has(flag)) return err(invalid(SPAWN_USAGE));
    seen.add(flag);
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.trim() === "") return err(invalid(SPAWN_USAGE));
    switch (flag) {
      case "--prompt":
      case "--prompt-file":
        if (source !== undefined) return err(invalid(SPAWN_USAGE));
        source = flag === "--prompt" ? { text: value } : { file: value };
        break;
      case "--id":
        if (!ORB_SPAWN_UUID.test(value)) return err(invalid("--id must be a UUID"));
        id = value.toLowerCase();
        break;
      case "--name":
        name = value;
        break;
      default:
        return err(invalid(SPAWN_USAGE));
    }
  }
  if (source === undefined) return err(invalid(SPAWN_USAGE));
  return ok({
    source,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    json,
  });
}

export function requestSpawn(
  env: BrokerEnv,
  id: string,
  request: OrbSpawnRequest,
): ResultAsync<OrbSpawnResponse, SpawnFailure> {
  const body = JSON.stringify(request);
  if (request.prompt.trim() === "" || Buffer.byteLength(body) > ORB_SPAWN_MAX_BYTES)
    return errAsync(invalid("spawn prompt is empty or exceeds the 1 MiB request limit"));
  const unknown = (): SpawnFailure => ({
    type: "spawn_failure",
    exitCode: 6,
    message: `spawn acceptance is unknown; retry with --id ${id} and the same prompt/name arguments`,
  });
  return ResultAsync.fromThrowable(async () => {
    const response = await fetch(`${env.controlPlaneUrl}/runtime/v1/orbs/${id}/spawn`, {
      method: "PUT",
      headers: { authorization: `Bearer ${env.runtimeToken}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }, unknown)().andThen(({ status, payload }) => {
    if (
      status === 202 &&
      Check(OrbSpawnResponseSchema, payload) &&
      payload.orbId === id &&
      payload.messageId === id
    )
      return ok(payload);
    if (status !== 202 && Check(OrbSpawnErrorSchema, payload)) {
      const code = payload.error.code;
      return err({
        type: "spawn_failure" as const,
        exitCode:
          code === "invalid_request"
            ? 2
            : code === "unauthorized"
              ? 3
              : code === "conflict" || code === "not_found"
                ? 4
                : code === "internal"
                  ? 7
                  : 6,
        message: `${payload.error.message}${payload.error.retryable ? `; retry with --id ${id} and the same prompt/name arguments` : ""}`,
      });
    }
    return err(unknown());
  });
}

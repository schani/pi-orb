import { NoSimulationTask } from "determined";
import { readBrokerEnv } from "../broker/endpoint.ts";
import {
  filterOrbs,
  formatOrbList,
  formatTranscript,
  INSPECTION_USAGE,
  parseInspectionArgs,
} from "./command.ts";
import { HttpOrbInspectionEndpoint, type InspectionEndpointFailure } from "./endpoint.ts";

function describeFailure(failure: InspectionEndpointFailure): string {
  switch (failure.kind) {
    case "unauthorized":
      return "the control plane rejected this orb's identity (replaced or retired compute?)";
    case "not_found":
    case "conflict":
    case "unavailable":
    case "internal":
      return failure.message;
  }
}

function exitCode(failure: InspectionEndpointFailure): number {
  switch (failure.kind) {
    case "unauthorized":
      return 3;
    case "not_found":
    case "conflict":
      return 4;
    case "unavailable":
      return 6;
    case "internal":
      return 7;
  }
}

async function main(): Promise<number> {
  const parsed = parseInspectionArgs(process.argv.slice(2));
  if (parsed.isErr()) {
    process.stderr.write(`pi-orb: ${parsed.error}\n`);
    return 2;
  }
  const env = readBrokerEnv(process.env);
  if (env === null) {
    process.stderr.write(
      `pi-orb: orb runtime environment missing (not inside an orb?)\n${INSPECTION_USAGE}\n`,
    );
    return 2;
  }

  const endpoint = new HttpOrbInspectionEndpoint(env);
  const task = new NoSimulationTask("orb-inspection-cli", false);
  if (parsed.value.type === "orbs") {
    const result = await endpoint.list(task);
    if (result.kind !== "list") {
      process.stderr.write(`pi-orb: ${describeFailure(result)}\n`);
      return exitCode(result);
    }
    const items = filterOrbs(result.value.items, parsed.value.query);
    process.stdout.write(
      parsed.value.json
        ? `${JSON.stringify({ ...result.value, items }, null, 2)}\n`
        : formatOrbList(items, result.value.currentOrbId),
    );
    return 0;
  }

  const result = await endpoint.transcript(task, parsed.value.orbId);
  if (result.kind !== "transcript") {
    process.stderr.write(`pi-orb: ${describeFailure(result)}\n`);
    return exitCode(result);
  }
  process.stdout.write(
    parsed.value.json
      ? `${JSON.stringify(result.value, null, 2)}\n`
      : formatTranscript(result.value),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`pi-orb: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

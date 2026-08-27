import {
  ORB_INSPECTION_LIST_PATH,
  OrbInspectionErrorSchema,
  type OrbInspectionList,
  OrbInspectionListSchema,
  type OrbTranscript,
  OrbTranscriptSchema,
  orbTranscriptPath,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const INSPECTION_REQUEST_TIMEOUT_MS = 3_000;

export type InspectionEndpointFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

export type OrbListEndpointResult =
  | { readonly kind: "list"; readonly value: OrbInspectionList }
  | InspectionEndpointFailure;

export type TranscriptEndpointResult =
  | { readonly kind: "transcript"; readonly value: OrbTranscript }
  | InspectionEndpointFailure;

interface HttpOutcome {
  readonly status: number;
  readonly payload: unknown;
}

type RawOutcome =
  | { readonly kind: "response"; readonly value: HttpOutcome }
  | InspectionEndpointFailure;

/** Runtime-bearer-authenticated transport for read-only sibling-orb inspection. */
export class HttpOrbInspectionEndpoint {
  private readonly env: BrokerEnv;

  constructor(env: BrokerEnv) {
    this.env = env;
  }

  async list(_task: SimulationTask): Promise<OrbListEndpointResult> {
    const response = await this.request(ORB_INSPECTION_LIST_PATH);
    if (response.kind !== "response") return response;
    if (response.value.status === 200) {
      return Check(OrbInspectionListSchema, response.value.payload)
        ? { kind: "list", value: response.value.payload }
        : { kind: "internal", message: "malformed orb list response" };
    }
    return failureOf(response.value);
  }

  async transcript(_task: SimulationTask, orbId: string): Promise<TranscriptEndpointResult> {
    const response = await this.request(orbTranscriptPath(orbId));
    if (response.kind !== "response") return response;
    if (response.value.status === 200) {
      return Check(OrbTranscriptSchema, response.value.payload)
        ? { kind: "transcript", value: response.value.payload }
        : { kind: "internal", message: "malformed transcript response" };
    }
    return failureOf(response.value);
  }

  private request(path: string): Promise<RawOutcome> {
    const deadline = AbortSignal.timeout(INSPECTION_REQUEST_TIMEOUT_MS);
    return fetch(`${this.env.controlPlaneUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.env.runtimeToken}` },
      signal: deadline,
    }).then(
      async (response): Promise<RawOutcome> => {
        let failed = false;
        const payload: unknown = await response.json().catch(() => {
          failed = true;
          return null;
        });
        if (failed && deadline.aborted) return timeoutFailure();
        return { kind: "response", value: { status: response.status, payload } };
      },
      (error: unknown): RawOutcome =>
        deadline.aborted
          ? timeoutFailure()
          : {
              kind: "unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
    );
  }
}

function timeoutFailure(): InspectionEndpointFailure {
  return {
    kind: "unavailable",
    message: `control plane did not answer within ${INSPECTION_REQUEST_TIMEOUT_MS}ms`,
  };
}

function failureOf(outcome: HttpOutcome): InspectionEndpointFailure {
  if (outcome.status === 401) return { kind: "unauthorized" };
  if (Check(OrbInspectionErrorSchema, outcome.payload)) {
    const error = outcome.payload.error;
    switch (error.code) {
      case "not_found":
        return { kind: "not_found", message: error.message };
      case "conflict":
        return { kind: "conflict", message: error.message };
      case "unavailable":
        return { kind: "unavailable", message: error.message };
      case "internal":
        return { kind: "internal", message: error.message };
    }
  }
  if (outcome.status >= 500) {
    return { kind: "unavailable", message: `control plane HTTP ${outcome.status}` };
  }
  return { kind: "internal", message: `control plane HTTP ${outcome.status}` };
}

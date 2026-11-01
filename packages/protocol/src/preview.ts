import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;
export const PREVIEW_ADMISSION_HEADER = "x-pi-orb-preview-admission";
export const PREVIEW_PATH_HEADER = "x-pi-orb-preview-path";
export const PREVIEW_ERROR_HEADER = "x-pi-orb-preview-error";
export const PreviewTargetSchema = Type.Object(
  {
    orbId: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    registrationId: Type.String({ minLength: 1 }),
    incarnation: Type.Integer({ minimum: 0 }),
    executionId: Type.String({ minLength: 1 }),
    runtimeInstanceId: Type.String({ minLength: 1 }),
  },
  closed,
);
export type PreviewTarget = Static<typeof PreviewTargetSchema>;
export const PreviewAdmissionSchema = Type.Object(
  {
    v: Type.Literal(1),
    target: PreviewTargetSchema,
    origin: Type.String({ minLength: 1 }),
    expiresAt: Type.Number(),
  },
  closed,
);
export type PreviewAdmission = Static<typeof PreviewAdmissionSchema>;
export interface PreviewRegistration {
  readonly port: number;
  readonly registrationId: string;
  readonly url: string;
}
export interface PreviewError {
  readonly type: "preview_error";
  readonly code:
    | "invalid_request"
    | "unauthenticated"
    | "forbidden"
    | "orb_not_found"
    | "port_not_registered"
    | "reserved_port"
    | "preview_disabled"
    | "unsupported_provider"
    | "orb_unavailable"
    | "stale_target"
    | "target_refused"
    | "upstream_failed"
    | "deadline_exceeded"
    | "capacity_exceeded"
    | "cancelled"
    | "store_unavailable";
  readonly message: string;
}

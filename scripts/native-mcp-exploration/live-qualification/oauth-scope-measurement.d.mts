import type { Result } from "neverthrow";

export const MAX_BYTES: number;

export interface ScopeMetric {
  kind: "authorization_code" | "refresh_token";
  outcome:
    | "present"
    | "omitted"
    | "invalid"
    | "http_error"
    | "oversize"
    | "unverified"
    | "oauth_error"
    | "invalid_response";
  knownScopes?: string[];
  unknownCount?: number;
  invalidReason?: "non_string" | "empty" | "invalid_syntax";
  boundaryWhitespace?: boolean;
  nonSpaceWhitespace?: boolean;
  disallowedCharacter?: boolean;
}
export function observeTokenResponses(
  fetcher: typeof fetch,
  options: {
    tokenEndpoint: string;
    knownScopes: string[];
    record(metric: ScopeMetric): void | Promise<void>;
  },
): Result<typeof fetch, { type: "invalid_configuration" }>;

import { type LoginTicket, OAuth2Client } from "google-auth-library";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type {
  IdentityVerificationError,
  UserIdentityVerifier,
  VerifiedUserIdentity,
} from "../domain/identity.ts";

const IAP_ISSUER = "https://cloud.google.com/iap";
const CLOCK_SKEW_SECONDS = 30;
// IAP documents ten minutes plus the 30-second skew at each edge.
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60 + 2 * CLOCK_SKEW_SECONDS;

export interface IapRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

interface IapJwtClient {
  getIapPublicKeysAsync(): Promise<unknown>;
  verifySignedJwtWithCertsAsync(
    jwt: string,
    certs: Record<string, string | object>,
    audience: string,
    issuers: string[],
  ): Promise<LoginTicket>;
}

interface ParsedAssertion {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

const parseJson = Result.fromThrowable(
  (encoded: string): unknown => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
  (): IdentityVerificationError => ({ type: "unauthenticated", message: "invalid IAP assertion" }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssertion(assertion: string): Result<ParsedAssertion, IdentityVerificationError> {
  const parts = assertion.split(".");
  if (parts.length !== 3) return err({ type: "unauthenticated", message: "invalid IAP assertion" });
  const header = parseJson(parts[0] ?? "");
  const payload = parseJson(parts[1] ?? "");
  if (header.isErr()) return err(header.error);
  if (payload.isErr()) return err(payload.error);
  if (!isRecord(header.value) || !isRecord(payload.value)) {
    return err({ type: "unauthenticated", message: "invalid IAP assertion" });
  }
  return ok({ header: header.value, payload: payload.value });
}

function validateClaims(
  parsed: ParsedAssertion,
  audience: string,
  nowSeconds: number,
): Result<VerifiedUserIdentity, IdentityVerificationError> {
  const { header, payload } = parsed;
  const sub = payload["sub"];
  const email = payload["email"];
  const iat = payload["iat"];
  const exp = payload["exp"];
  if (
    header.alg !== "ES256" ||
    typeof header.kid !== "string" ||
    header.kid === "" ||
    payload["iss"] !== IAP_ISSUER ||
    payload["aud"] !== audience ||
    typeof sub !== "string" ||
    sub.trim() === "" ||
    (email !== undefined && typeof email !== "string") ||
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    typeof exp !== "number" ||
    !Number.isFinite(exp) ||
    iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    exp < nowSeconds - CLOCK_SKEW_SECONDS ||
    exp <= iat ||
    exp - iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    return err({ type: "unauthenticated", message: "invalid IAP assertion" });
  }
  return ok({ issuer: IAP_ISSUER, subject: sub, email: typeof email === "string" ? email : null });
}

export function readIapAudience(value: string): Result<string, string> {
  return /^\/projects\/[1-9][0-9]*\/locations\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/services\/[a-z](?:[a-z0-9-]*[a-z0-9])?$/u.test(
    value,
  )
    ? ok(value)
    : err("must be /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME");
}

type PublicKeys = Record<string, string | object>;
interface PublicKeyResponse {
  readonly pubkeys: PublicKeys;
  readonly cacheControl: string | null;
}

const malformedKeyResponse = (): IdentityVerificationError => ({
  type: "identity_unavailable",
  message: "IAP verification unavailable",
});

const parsePublicKeyResponse = Result.fromThrowable(
  (value: unknown): Result<PublicKeyResponse, IdentityVerificationError> => {
    if (!isRecord(value) || !isRecord(value["pubkeys"])) return err(malformedKeyResponse());
    const pubkeys: PublicKeys = {};
    for (const [kid, key] of Object.entries(value["pubkeys"])) {
      if (typeof key !== "string" && !isRecord(key)) return err(malformedKeyResponse());
      pubkeys[kid] = key;
    }
    const res = value["res"];
    let cacheControl: string | null = null;
    if (isRecord(res) && isRecord(res["headers"])) {
      const headers = res["headers"];
      if (typeof headers["get"] === "function") {
        const header = headers["get"]("cache-control");
        cacheControl = typeof header === "string" ? header : null;
      } else if (typeof headers["cache-control"] === "string") {
        cacheControl = headers["cache-control"];
      }
    }
    return ok({ pubkeys, cacheControl });
  },
  malformedKeyResponse,
);

function cacheMaxAge(cacheControl: string | null): number {
  if (cacheControl !== null && /(?:^|,)\s*(?:no-cache|no-store)(?:,|$)/iu.test(cacheControl)) {
    return 0;
  }
  const match = cacheControl === null ? null : /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl);
  const seconds = match?.[1] === undefined ? 300 : Number(match[1]);
  return Math.max(0, Math.min(seconds * 1_000, 60 * 60 * 1_000));
}

const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30_000;

/** Small provider-directed cache: one in-flight fetch, bounded TTL, forced refresh on key rotation. */
export class IapPublicKeyCache {
  private cached: { readonly keys: PublicKeys; readonly expiresAt: number } | null = null;
  private unknownKidRefreshAfter = 0;
  private inFlight: Promise<Result<PublicKeys, IdentityVerificationError>> | null = null;
  private readonly client: IapJwtClient;
  private readonly now: () => number;

  constructor(client: IapJwtClient, now: () => number) {
    this.client = client;
    this.now = now;
  }

  get(forceRefresh = false): ResultAsync<PublicKeys, IdentityVerificationError> {
    if (this.inFlight !== null) return new ResultAsync(this.inFlight);
    if (!forceRefresh && this.cached !== null && this.cached.expiresAt > this.now()) {
      return ResultAsync.fromSafePromise(Promise.resolve(this.cached.keys));
    }
    const inFlight = (async (): Promise<Result<PublicKeys, IdentityVerificationError>> => {
      const fetched = await ResultAsync.fromThrowable(
        () => this.client.getIapPublicKeysAsync(),
        malformedKeyResponse,
      )();
      this.inFlight = null;
      if (fetched.isErr()) return err(fetched.error);
      const parsed = parsePublicKeyResponse(fetched.value);
      if (parsed.isErr()) return err(parsed.error);
      const response = parsed.value;
      if (response.isErr()) return err(response.error);
      const now = this.now();
      this.cached = {
        keys: response.value.pubkeys,
        expiresAt: now + cacheMaxAge(response.value.cacheControl),
      };
      return ok(response.value.pubkeys);
    })();
    this.inFlight = inFlight;
    return new ResultAsync(inFlight);
  }

  getForKid(kid: string): ResultAsync<PublicKeys, IdentityVerificationError> {
    const cached = this.cached;
    const cachedIsFresh = cached !== null && cached.expiresAt > this.now();
    if (!cachedIsFresh || Object.hasOwn(cached.keys, kid)) return this.get();
    if (this.now() < this.unknownKidRefreshAfter) return this.get();
    this.unknownKidRefreshAfter = this.now() + UNKNOWN_KID_REFRESH_COOLDOWN_MS;
    return this.get(true);
  }
}

export class IapIdentityVerifier implements UserIdentityVerifier<IapRequest> {
  private readonly client: IapJwtClient;
  private readonly keys: IapPublicKeyCache;
  private readonly audience: string;
  private readonly now: () => number;

  constructor(audience: string, now: () => number, client?: IapJwtClient) {
    this.audience = audience;
    this.now = now;
    this.client =
      client ??
      (new OAuth2Client({ transporterOptions: { timeout: 5_000 } }) as unknown as IapJwtClient);
    this.keys = new IapPublicKeyCache(this.client, now);
  }

  verify(request: IapRequest): ResultAsync<VerifiedUserIdentity, IdentityVerificationError> {
    const header = request.headers["x-goog-iap-jwt-assertion"];
    if (typeof header !== "string" || header === "") {
      return errAsync({ type: "unauthenticated", message: "IAP assertion required" });
    }
    const parsed = parseAssertion(header);
    if (parsed.isErr()) return errAsync(parsed.error);
    const claims = validateClaims(parsed.value, this.audience, this.now() / 1_000);
    if (claims.isErr()) return errAsync(claims.error);

    const verifyWithKeys = (pubkeys: PublicKeys) => {
      if (!Object.hasOwn(pubkeys, String(parsed.value.header.kid))) {
        return errAsync({ type: "unauthenticated" as const, message: "invalid IAP assertion" });
      }
      return ResultAsync.fromThrowable(
        () =>
          this.client.verifySignedJwtWithCertsAsync(header, pubkeys, this.audience, [IAP_ISSUER]),
        () => ({ type: "unauthenticated" as const, message: "invalid IAP assertion" }),
      )().map(() => claims.value);
    };
    return this.keys.getForKid(String(parsed.value.header.kid)).andThen(verifyWithKeys);
  }
}

import { err, ok, Result } from "neverthrow";

/**
 * Hosts allowed to serve the issuer over plain HTTP. Everything else must be
 * `https:`: the issuer URL is the trust anchor a relying party pins, and a
 * cleartext one is trivially impersonated. Loopback stays permitted so local
 * development — where the whole deployment is one process on one machine —
 * works without a certificate.
 */
const LOOPBACK_ISSUER_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `PI_ORB_OIDC_ISSUER_URL` validated and canonicalized
 * (docs/workload-identity.md). Any role that mints or publishes issuer
 * metadata refuses to boot without a usable value, before any side effect —
 * the exact-image pin precedent in `adapters/gce/image-pin.ts`.
 *
 * The canonical form is the bare origin: scheme, host, and non-default port.
 * That string is served as `issuer`, stamped into every token's `iss`, and
 * prefixed to `jwks_uri`, so `https://issuer.example/` must not become a second
 * trust identity. Paths are refused rather than dropped: the well-known
 * documents live at the origin root, so a path would advertise documents that
 * are not there.
 *
 * `fallback` applies when the variable is unset: the loopback origin for the
 * single-process `all` role, null for a split deployment (no truthful default).
 */
export function readIssuerUrl(configured: string, fallback: string | null): Result<string, string> {
  const raw = configured !== "" ? configured : fallback;
  if (raw === null) return err("is required for the issuer and runtime roles");
  const parsed = Result.fromThrowable(
    () => new URL(raw),
    () => "is not an absolute URL",
  )();
  if (parsed.isErr()) return err(parsed.error);
  const url = parsed.value;
  if (url.protocol !== "https:" && url.protocol !== "http:") return err("must be http(s)");
  if (url.protocol !== "https:" && !LOOPBACK_ISSUER_HOSTS.has(url.hostname)) {
    return err("must be https: except for loopback hosts");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    return err("must be a bare origin, with no path, query, fragment, or credentials");
  }
  return ok(url.origin);
}

import { err, ok, Result } from "neverthrow";

type OrbFileUrlError = { type: "invalid_orb_file_uri" };
const invalid = (): OrbFileUrlError => ({ type: "invalid_orb_file_uri" });
const parseUrl = Result.fromThrowable((value: string) => new URL(value), invalid);
const decode = Result.fromThrowable(decodeURIComponent, invalid);
const encode = Result.fromThrowable(encodeURIComponent, invalid);

export function resolveOrbFileUrl(
  uri: string,
  filesBaseUrl: string | undefined,
): Result<string, OrbFileUrlError> {
  if (!/^orb:/i.test(uri) || !filesBaseUrl) return err(invalid());
  const parsed = parseUrl(filesBaseUrl);
  if (parsed.isErr()) return err(parsed.error);
  const base = parsed.value;
  const orb = /^\/files\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(base.pathname);
  if (
    !orb ||
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return err(invalid());

  const destination = uri.slice(4);
  const suffixAt = destination.search(/[?#]/);
  const path = suffixAt === -1 ? destination : destination.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : destination.slice(suffixAt);
  const decodedSuffix = decode(suffix);
  if (decodedSuffix.isErr()) return decodedSuffix;
  if (/[\\\p{Cc}]/u.test(decodedSuffix.value)) return err(invalid());
  const absolute = path.startsWith("/");
  if (path.startsWith("//")) return err(invalid());
  const segments = (absolute ? path.slice(1) : path).split("/");
  const encoded: string[] = [];
  for (const segment of segments) {
    const decoded = decode(segment);
    if (decoded.isErr()) return decoded;
    if (
      decoded.value === "" ||
      decoded.value === "." ||
      decoded.value === ".." ||
      /[/\\\p{Cc}]/u.test(decoded.value)
    )
      return err(invalid());
    const result = encode(decoded.value);
    if (result.isErr()) return result;
    encoded.push(result.value);
  }
  const prefix = absolute ? base.pathname : `/files/repo/${orb[1]}`;
  return ok(`${base.origin}${prefix}/${encoded.join("/")}${suffix}`);
}

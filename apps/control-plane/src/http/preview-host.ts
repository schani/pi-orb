import { err, ok, Result } from "neverthrow";
import { getDomain } from "tldts";

export interface PreviewTarget {
  readonly orbId: string;
  readonly port: number;
  readonly origin: string;
}
export interface PreviewHosts {
  readonly baseOrigin: string;
  parse(authority: string | undefined): PreviewTarget | undefined;
  url(orbId: string, port: number): Result<string, { type: "invalid_preview_target" }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function createPreviewHosts(config: {
  previewOrigin: string;
  appOrigin: string;
  filesOrigin: string;
  local?: boolean;
}): Result<PreviewHosts, { type: "invalid_preview_origin" }> {
  const invalid = () => ({ type: "invalid_preview_origin" as const });
  const parsed = Result.fromThrowable(
    () =>
      [config.previewOrigin, config.appOrigin, config.filesOrigin].map((value) => new URL(value)),
    invalid,
  )();
  if (parsed.isErr()) return err(invalid());
  const [base, app, files] = parsed.value;
  if (
    !base ||
    !app ||
    !files ||
    config.previewOrigin !== base.origin ||
    base.username ||
    base.password
  )
    return err(invalid());
  const localhost = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  if (base.protocol !== "https:" && !(config.local && localhost && base.protocol === "http:"))
    return err(invalid());
  const domain = getDomain(base.hostname, { allowPrivateDomains: true });
  if (
    !localhost &&
    (!domain ||
      [app, files].some((url) => getDomain(url.hostname, { allowPrivateDomains: true }) === domain))
  )
    return err(invalid());
  if (localhost && !config.local) return err(invalid());
  const url = (orbId: string, port: number): Result<string, { type: "invalid_preview_target" }> =>
    uuid.test(orbId) && Number.isInteger(port) && port >= 1 && port <= 65535
      ? ok(`${base.protocol}//p${port}-o${orbId}.${base.host}`)
      : err({ type: "invalid_preview_target" });
  return ok({
    baseOrigin: base.origin,
    url,
    parse(authority) {
      if (!authority) return undefined;
      const suffix = `.${base.host}`;
      if (!authority.endsWith(suffix)) return undefined;
      const match = /^p([1-9][0-9]{0,4})-o(.+)$/u.exec(authority.slice(0, -suffix.length));
      if (!match) return undefined;
      const orbId = match[2] ?? "";
      const port = Number(match[1]);
      const origin = url(orbId, port);
      return origin.isOk() ? { orbId, port, origin: origin.value } : undefined;
    },
  });
}

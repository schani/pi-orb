import { join } from "node:path";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { createHostingAccessPolicy, type HostingAccessPolicy } from "./http/hosting-access.ts";

export type HostingConfiguration = {
  readonly appOrigin: string;
  readonly runtimeOrigin: string;
  readonly filesOrigin: string;
  readonly trustedLocalOrigins: readonly string[];
  readonly trustedLocal: boolean;
  readonly store:
    | { readonly kind: "filesystem"; readonly root: string }
    | { readonly bucket: string; readonly kind: "gcs" };
};
export type HostingConfigurationError = {
  readonly type: "hosting_configuration_error";
  readonly message: string;
};

export function createConfiguredHostingAccessPolicy(
  configuration: HostingConfiguration,
): ResultType<HostingAccessPolicy, HostingConfigurationError> {
  return createHostingAccessPolicy({
    filesOrigin: configuration.filesOrigin,
    appOrigin: configuration.appOrigin,
    runtimeOrigin: configuration.runtimeOrigin,
    trustedLocalOrigins: configuration.trustedLocalOrigins,
    trustedLocal: configuration.trustedLocal,
  }).mapErr((error) => ({ type: "hosting_configuration_error", message: error.message }));
}

const invalid = (message: string): ResultType<never, HostingConfigurationError> =>
  err({ type: "hosting_configuration_error", message });
const parseOrigin = Result.fromThrowable(
  (value: string) => new URL(value),
  () => "invalid origin",
);
const isExactOrigin = (url: URL): boolean =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.username === "" &&
  url.password === "" &&
  url.pathname === "/" &&
  url.search === "" &&
  url.hash === "";

export function readHostingConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  port: number,
  home: string,
): ResultType<HostingConfiguration, HostingConfigurationError> {
  const split = environment["PI_ORB_AUTH_MODE"] !== "local";
  if (!split && environment["K_SERVICE"] !== undefined)
    return invalid("Local authentication is forbidden in Cloud Run");
  const kind = environment["PI_ORB_HOSTING_STORE"] ?? (split ? "" : "filesystem");
  if (kind !== "filesystem" && kind !== "gcs")
    return invalid("PI_ORB_HOSTING_STORE must be filesystem or gcs");
  const filesValue =
    environment["PI_ORB_HOSTING_ORIGIN"] ?? (split ? "" : `http://files.localhost:${port}`);
  const appValue = environment["PI_ORB_APP_ORIGIN"] ?? (split ? "" : `http://127.0.0.1:${port}`);
  if (filesValue === "" || appValue === "")
    return invalid("PI_ORB_HOSTING_ORIGIN and PI_ORB_APP_ORIGIN are required");
  const runtimeValue =
    environment["PI_ORB_BROKER_URL"] ||
    (!split && (environment["PI_ORB_HOST_PROVIDER"] ?? "docker") === "docker"
      ? `http://host.docker.internal:${port}`
      : appValue);
  const trustedLocalOrigins = split ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];
  const trustedLocal = !split;
  const policy = createHostingAccessPolicy({
    filesOrigin: filesValue,
    appOrigin: appValue,
    runtimeOrigin: runtimeValue,
    trustedLocalOrigins,
    trustedLocal,
  });
  if (policy.isErr()) return invalid(policy.error.message);
  const appOrigin = parseOrigin(appValue);
  const filesOrigin = parseOrigin(filesValue);
  const runtimeOrigin = parseOrigin(runtimeValue);
  if (
    appOrigin.isErr() ||
    filesOrigin.isErr() ||
    runtimeOrigin.isErr() ||
    !isExactOrigin(appOrigin.value) ||
    !isExactOrigin(filesOrigin.value)
  )
    return invalid("hosting origins are invalid");
  if (split && (appOrigin.value.protocol !== "https:" || filesOrigin.value.protocol !== "https:"))
    return invalid("Production origins require HTTPS");
  if (appOrigin.value.hostname === filesOrigin.value.hostname)
    return invalid("appOrigin and filesOrigin must use different hostnames");
  if (kind === "gcs") {
    const bucket = environment["PI_ORB_HOSTING_BUCKET"] ?? "";
    if (bucket === "") return invalid("PI_ORB_HOSTING_BUCKET is required for GCS hosting");
    return ok({
      trustedLocal,
      trustedLocalOrigins,
      appOrigin: appOrigin.value.origin,
      runtimeOrigin: runtimeOrigin.value.origin,
      filesOrigin: filesOrigin.value.origin,
      store: { bucket, kind },
    });
  }
  return ok({
    trustedLocal,
    trustedLocalOrigins,
    appOrigin: appOrigin.value.origin,
    runtimeOrigin: runtimeOrigin.value.origin,
    filesOrigin: filesOrigin.value.origin,
    store: {
      kind,
      root: environment["PI_ORB_HOSTING_ROOT"] ?? join(home, ".pi-orb", "hosting"),
    },
  });
}

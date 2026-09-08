import { join } from "node:path";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { createHostingAccessPolicy, type HostingAccessPolicy } from "./http/hosting-access.ts";

export type ControlPlaneRole = "all" | "browser" | "runtime" | "ops" | "issuer";
export type HostingConfiguration = {
  readonly appOrigin: string;
  readonly filesOrigin: string;
  readonly store:
    | { readonly kind: "filesystem"; readonly root: string }
    | { readonly bucket: string; readonly kind: "gcs" };
  readonly trustedBrowserOrigins: readonly string[];
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
    trustedBrowserOrigins: configuration.trustedBrowserOrigins,
  }).mapErr((error) => ({ type: "hosting_configuration_error", message: error.message }));
}

const invalid = (message: string): ResultType<never, HostingConfigurationError> =>
  err({ type: "hosting_configuration_error", message });
const parseOrigin = Result.fromThrowable(
  (value: string) => new URL(value).origin,
  () => "invalid origin",
);

export function readHostingConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  role: ControlPlaneRole,
  port: number,
  home: string,
): ResultType<HostingConfiguration | null, HostingConfigurationError> {
  if (role === "issuer") return ok(null);
  const split = role !== "all";
  const kind = environment["PI_ORB_HOSTING_STORE"] ?? (split ? "" : "filesystem");
  if (kind !== "filesystem" && kind !== "gcs")
    return invalid("PI_ORB_HOSTING_STORE must be filesystem or gcs");
  const filesValue =
    environment["PI_ORB_HOSTING_ORIGIN"] ?? (split ? "" : `http://files.localhost:${port}`);
  const appValue = environment["PI_ORB_APP_ORIGIN"] ?? (split ? "" : `http://127.0.0.1:${port}`);
  if (filesValue === "" || appValue === "")
    return invalid("PI_ORB_HOSTING_ORIGIN and PI_ORB_APP_ORIGIN are required");
  const trustedBrowserOrigins =
    role === "all" ? ["http://localhost:5173", "http://127.0.0.1:5173"] : [];
  const policy = createHostingAccessPolicy({
    appOrigin: appValue,
    filesOrigin: filesValue,
    trustedBrowserOrigins,
  });
  if (policy.isErr()) return invalid(policy.error.message);
  const appOrigin = parseOrigin(appValue);
  const filesOrigin = parseOrigin(filesValue);
  if (appOrigin.isErr() || filesOrigin.isErr()) return invalid("hosting origins are invalid");
  if (kind === "gcs") {
    const bucket = environment["PI_ORB_HOSTING_BUCKET"] ?? "";
    if (bucket === "") return invalid("PI_ORB_HOSTING_BUCKET is required for GCS hosting");
    return ok({
      appOrigin: appOrigin.value,
      filesOrigin: filesOrigin.value,
      store: { bucket, kind },
      trustedBrowserOrigins,
    });
  }
  return ok({
    appOrigin: appOrigin.value,
    filesOrigin: filesOrigin.value,
    store: {
      kind,
      root: environment["PI_ORB_HOSTING_ROOT"] ?? join(home, ".pi-orb", "hosting"),
    },
    trustedBrowserOrigins,
  });
}

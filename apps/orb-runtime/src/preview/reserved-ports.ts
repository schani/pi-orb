import { CONTROL_PLANE_URL_ENV } from "@pi-orb/protocol";
import { Result } from "neverthrow";

export function runtimeReservedPorts(
  listener: number,
  environment: Readonly<Record<string, string | undefined>>,
): number[] {
  const ports = [8080, listener, Number(environment.PI_ORB_RUNTIME_PORT), Number(environment.PORT)];
  const platform = environment[CONTROL_PLANE_URL_ENV];
  if (platform) {
    const parsed = Result.fromThrowable(
      () => new URL(platform),
      () => null,
    )();
    if (parsed.isOk() && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.value.hostname))
      ports.push(Number(parsed.value.port || (parsed.value.protocol === "https:" ? 443 : 80)));
  }
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

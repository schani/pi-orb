import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, Result, type ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../apps/control-plane/src/domain/errors.ts";
import type {
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  ProvisionOrbHostRequest,
  StartOrbHostRequest,
} from "../../apps/control-plane/src/domain/ports.ts";

interface Fixture {
  orbId: string;
  token: string;
  instance: string;
  runtimeUrl: string;
}

// The experiment driver owns real VM operations. This adapter only admits its
// one prepared fixture; it cannot enumerate or mutate cloud resources.
export class DockerOrbHostProvider implements OrbHostProvider {
  readonly kind = "native-vm-experiment";
  readonly specGeneration = 1;
  private registered = false;
  desiredSpecFingerprint(): string {
    return "native-vm-experiment-v1";
  }
  private fixture() {
    return Result.fromThrowable(
      () => JSON.parse(readFileSync(process.env["NATIVE_VM_FIXTURE"] ?? "", "utf8")) as Fixture,
      (): OrbHostProviderError => ({
        type: "orb_host_provider_error",
        provider: this.kind,
        operation: "observe",
        code: "unavailable",
        message: "fixture unavailable",
        retryable: false,
      }),
    )();
  }
  provision(_task: SimulationTask, request: ProvisionOrbHostRequest) {
    const read = this.fixture();
    if (read.isErr()) return errAsync(read.error);
    const fixture = read.value;
    if (request.orbId !== fixture.orbId || request.incarnation !== 0)
      return this.unsupported("provision");
    this.registered = true;
    return okAsync({
      ref: { provider: this.kind, resourceId: fixture.instance },
      incarnation: 0,
      runtimeTokenHash: createHash("sha256").update(fixture.token).digest("hex"),
      specFingerprint: this.desiredSpecFingerprint(),
      specGeneration: this.specGeneration,
    });
  }
  private observation(fixture: Fixture): OrbHostObservation {
    return {
      ref: { provider: this.kind, resourceId: fixture.instance },
      orbId: fixture.orbId,
      incarnation: 0,
      specFingerprint: this.desiredSpecFingerprint(),
      state: "running",
      runtimeAddress: { baseUrl: fixture.runtimeUrl },
    };
  }
  observe(_task: SimulationTask, ref: OrbHostRef) {
    const read = this.fixture();
    if (read.isErr()) return errAsync(read.error);
    this.registered = ref.resourceId === read.value.instance;
    return okAsync(this.registered ? this.observation(read.value) : null);
  }
  listManagedHosts() {
    const read = this.fixture();
    if (read.isErr()) return errAsync(read.error);
    return okAsync(this.registered ? [this.observation(read.value)] : []);
  }
  start(_task: SimulationTask, _request: StartOrbHostRequest) {
    return this.unsupported("start");
  }
  stop() {
    return this.unsupported("stop");
  }
  discardCompute() {
    return this.unsupported("discard");
  }
  destroy() {
    return this.unsupported("destroy");
  }
  diagnose() {
    return okAsync(
      "Experiment VM operations and journal evidence are owned by the external driver.",
    );
  }
  private unsupported(
    operation: OrbHostProviderError["operation"],
  ): ResultAsync<never, OrbHostProviderError> {
    return errAsync({
      type: "orb_host_provider_error",
      provider: this.kind,
      operation,
      code: "unavailable",
      message: "VM mutation belongs to the experiment driver",
      retryable: false,
    });
  }
}

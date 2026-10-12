import type { RuntimeHealth } from "@pi-orb/protocol";
import { RuntimePreviewService } from "../domain/preview.ts";
import { PreviewActivity } from "../domain/preview-activity.ts";
import { HmacPreviewVerifier } from "../preview/admission.ts";

export interface ExecutionPreviewOptions {
  readonly boot: {
    readonly runtimeInstanceId: string;
    health(): RuntimeHealth;
    /** True once the checkout is ready and until shutdown. */
    accepting(): boolean;
  };
  readonly orbId: string;
  readonly token: string;
  readonly reservedPorts: () => readonly number[];
}

/** Central idle stop is governed by the control plane's durable preview lease, not this activity. */
export function createExecutionPreview(options: ExecutionPreviewOptions): RuntimePreviewService {
  return new RuntimePreviewService({
    agent: {
      runtimeInstanceId: options.boot.runtimeInstanceId,
      previewActivity: new PreviewActivity(),
      getHealth: () => options.boot.health(),
      gateView: () => ({ acceptingWork: options.boot.accepting() }),
    },
    orbId: options.orbId,
    verifier: new HmacPreviewVerifier(options.token),
    reservedPorts: options.reservedPorts,
  });
}

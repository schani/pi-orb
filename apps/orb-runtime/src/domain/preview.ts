import type { PreviewAdmission, PreviewError, PreviewTarget } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import type { OrbAgent } from "./orb-agent.ts";
import type { PreviewLease } from "./preview-activity.ts";

export interface PreviewVerifier {
  verify(encoded: string, now: number): Result<PreviewAdmission, PreviewError>;
}
export interface RuntimePreviewOptions {
  agent: OrbAgent;
  orbId: string;
  verifier: PreviewVerifier;
  reservedPorts: () => readonly number[];
  now?: () => number;
}
export interface PreviewAdmissionLease extends PreviewLease {
  readonly origin: string;
}
export interface PreviewConnection {
  open(lease: PreviewLease, origin: string): () => void;
}
export class RuntimePreviewService {
  private readonly connections = new Set<() => void>();
  private owned = 0;
  private closing = false;
  open(lease: PreviewAdmissionLease, connection: PreviewConnection): Result<void, PreviewError> {
    if (this.closing || !this.options.agent.gateView().acceptingWork) {
      lease.release();
      return err({
        type: "preview_error",
        code: "orb_unavailable",
        message: "Runtime is stopping",
      });
    }
    let ended = false;
    let dispose: (() => void) | undefined;
    dispose = connection.open(
      {
        touch: () => lease.touch(),
        release: () => {
          ended = true;
          lease.release();
          if (dispose) this.connections.delete(dispose);
        },
      },
      lease.origin,
    );
    if (!ended) this.connections.add(dispose);
    return ok(undefined);
  }
  closeAll(): void {
    this.closing = true;
    for (const dispose of this.connections) dispose();
    this.connections.clear();
  }
  private readonly options: RuntimePreviewOptions;
  constructor(options: RuntimePreviewOptions) {
    this.options = options;
  }
  admit(
    encoded: string,
    port: number,
    kind: "http" | "websocket",
  ): Result<PreviewAdmissionLease, PreviewError> {
    const fail = (code: PreviewError["code"], message: string) =>
      err<PreviewAdmissionLease, PreviewError>({ type: "preview_error", code, message });
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return fail("invalid_request", "Invalid preview port");
    if (this.options.reservedPorts().includes(port))
      return fail("reserved_port", "Reserved preview port");
    const verified = this.options.verifier.verify(encoded, (this.options.now ?? Date.now)());
    if (verified.isErr()) return err(verified.error);
    const target: PreviewTarget = verified.value.target;
    const health = this.options.agent.getHealth();
    if (this.closing || health.status !== "ready" || !this.options.agent.gateView().acceptingWork)
      return fail("orb_unavailable", "Runtime is not accepting preview requests");
    if (
      target.port !== port ||
      target.orbId !== this.options.orbId ||
      target.incarnation !== health.incarnation ||
      target.executionId !== health.executionId ||
      target.runtimeInstanceId !== this.options.agent.runtimeInstanceId
    )
      return fail("stale_target", "Preview target changed");
    if (this.owned >= 64) return fail("capacity_exceeded", "Preview connection limit reached");
    this.owned++;
    const activity = this.options.agent.previewActivity.acquire(kind);
    let released = false;
    return ok({
      origin: verified.value.origin,
      touch: () => activity.touch(),
      release: () => {
        if (released) return;
        released = true;
        this.owned--;
        activity.release();
      },
    });
  }
}

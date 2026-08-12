import type { GceApiTransport, GceResponse } from "../adapters/gce/api.ts";

interface ModeledResource {
  body: Record<string, unknown>;
  deletionVisibilityRemaining: number | null;
}

interface ModeledOperation {
  pollsRemaining: number;
  effect: () => void;
  applied: boolean;
}

export interface DeterministicGceApiModelOptions {
  /** Number of wait calls that report RUNNING before DONE. */
  readonly operationWaitPolls?: number;
  /** List calls that still expose a deleted resource after its operation is DONE. */
  readonly deletionVisibilityPolls?: number;
}

/**
 * Stateful deterministic Compute Engine transport model. It deliberately runs
 * the real GCE adapter state machine under DST; only Google's remote resource
 * state is modeled here (docs/compute-replacement.md).
 */
export class DeterministicGceApiModel implements GceApiTransport {
  private readonly instances = new Map<string, ModeledResource>();
  private readonly disks = new Map<string, ModeledResource>();
  private readonly operations = new Map<string, ModeledOperation>();
  private nextOperation = 1;
  private readonly options: Required<DeterministicGceApiModelOptions>;

  constructor(options: DeterministicGceApiModelOptions = {}) {
    this.options = {
      operationWaitPolls: options.operationWaitPolls ?? 0,
      deletionVisibilityPolls: options.deletionVisibilityPolls ?? 0,
    };
  }

  seedInstance(name: string, labels: Record<string, string>, status = "RUNNING"): void {
    this.instances.set(name, {
      body: {
        name,
        labels: { ...labels },
        status,
        metadata: { fingerprint: `fp-${name}`, items: [] },
        networkInterfaces: [{ networkIP: "10.0.0.2" }],
      },
      deletionVisibilityRemaining: null,
    });
  }

  seedDisk(name: string, labels: Record<string, string>): void {
    this.disks.set(name, {
      body: { name, labels: { ...labels } },
      deletionVisibilityRemaining: null,
    });
  }

  hasInstance(name: string): boolean {
    return this.instances.has(name);
  }

  hasDisk(name: string): boolean {
    return this.disks.has(name);
  }

  pendingOperationCount(): number {
    return [...this.operations.values()].filter((operation) => !operation.applied).length;
  }

  /** Model cloud completion after the initiating control-plane process died. */
  completeAllOperations(): void {
    for (const operation of this.operations.values()) {
      if (operation.applied) continue;
      operation.effect();
      operation.applied = true;
      operation.pollsRemaining = 0;
    }
  }

  private operation(effect: () => void): GceResponse {
    const name = `model-op-${this.nextOperation}`;
    this.nextOperation += 1;
    this.operations.set(name, {
      pollsRemaining: this.options.operationWaitPolls,
      effect,
      applied: false,
    });
    return { status: 200, body: { name } };
  }

  private materializeVisibility(resources: Map<string, ModeledResource>): void {
    for (const [name, resource] of resources) {
      const remaining = resource.deletionVisibilityRemaining;
      if (remaining === null) continue;
      if (remaining <= 0) resources.delete(name);
      else resource.deletionVisibilityRemaining = remaining - 1;
    }
  }

  private labelFilter(path: string): { key: string; value: string } | null {
    const query = path.split("?", 2)[1];
    if (query === undefined) return null;
    const filter = new URLSearchParams(query).get("filter");
    const match = /^labels\.([^=]+)=(.+)$/.exec(filter ?? "");
    return match?.[1] === undefined || match[2] === undefined
      ? null
      : { key: match[1], value: match[2] };
  }

  private list(resources: Map<string, ModeledResource>, path: string): GceResponse {
    this.materializeVisibility(resources);
    const filter = this.labelFilter(path);
    const items = [...resources.values()]
      .filter((resource) => {
        if (filter === null) return true;
        const labels = (resource.body["labels"] ?? {}) as Record<string, unknown>;
        return labels[filter.key] === filter.value;
      })
      .map((resource) => structuredClone(resource.body));
    return { status: 200, body: { items } };
  }

  /**
   * A resource that is live from the API's perspective. Real Compute Engine
   * makes the single-resource GET (and every instance-targeted operation)
   * 404 promptly once its delete operation is DONE; only LIST snapshots may
   * trail. A completed deletion therefore hides the resource here
   * immediately, while `materializeVisibility` keeps the configurable
   * list-lag knob.
   */
  private live(resources: Map<string, ModeledResource>, name: string): ModeledResource | undefined {
    const resource = resources.get(name);
    return resource === undefined || resource.deletionVisibilityRemaining !== null
      ? undefined
      : resource;
  }

  private get(resources: Map<string, ModeledResource>, name: string): GceResponse {
    const resource = this.live(resources, name);
    return resource === undefined
      ? { status: 404, body: {} }
      : { status: 200, body: structuredClone(resource.body) };
  }

  async request(args: {
    readonly method: "GET" | "POST" | "DELETE";
    readonly path: string;
    readonly body?: Record<string, unknown>;
    readonly signal: AbortSignal;
  }): Promise<GceResponse> {
    if (args.signal.aborted) return { status: 499, body: {} };
    const relative = args.path.replace(/^projects\/[^/]+\/zones\/[^/]+\//, "");

    const wait = /^operations\/([^/]+)\/wait$/.exec(relative);
    if (args.method === "POST" && wait?.[1] !== undefined) {
      const operation = this.operations.get(wait[1]);
      if (operation === undefined) return { status: 404, body: {} };
      if (operation.pollsRemaining > 0) {
        operation.pollsRemaining -= 1;
        return { status: 200, body: { status: "RUNNING" } };
      }
      if (!operation.applied) {
        operation.effect();
        operation.applied = true;
      }
      return { status: 200, body: { status: "DONE" } };
    }

    if (args.method === "GET" && relative.startsWith("instances?")) {
      return this.list(this.instances, relative);
    }
    if (args.method === "GET" && relative.startsWith("disks?")) {
      return this.list(this.disks, relative);
    }

    const guest = /^instances\/([^/]+)\/getGuestAttributes/.exec(relative);
    if (args.method === "GET" && guest !== null) return { status: 404, body: {} };

    const instance = /^instances\/([^/?]+)$/.exec(relative);
    if (args.method === "GET" && instance?.[1] !== undefined) {
      return this.get(this.instances, instance[1]);
    }
    if (args.method === "DELETE" && instance?.[1] !== undefined) {
      const resource = this.live(this.instances, instance[1]);
      if (resource === undefined) return { status: 404, body: {} };
      return this.operation(() => {
        resource.deletionVisibilityRemaining = this.options.deletionVisibilityPolls;
      });
    }
    if (args.method === "POST" && relative === "instances") {
      const name = args.body?.["name"];
      if (typeof name !== "string") return { status: 400, body: {} };
      if (this.live(this.instances, name) !== undefined) return { status: 409, body: {} };
      return this.operation(() => {
        this.instances.set(name, {
          body: {
            ...(args.body ?? {}),
            name,
            status: "RUNNING",
            networkInterfaces: [{ networkIP: "10.0.0.2" }],
          },
          deletionVisibilityRemaining: null,
        });
      });
    }

    const startStop = /^instances\/([^/]+)\/(start|stop)$/.exec(relative);
    if (args.method === "POST" && startStop?.[1] !== undefined && startStop[2] !== undefined) {
      const resource = this.live(this.instances, startStop[1]);
      if (resource === undefined) return { status: 404, body: {} };
      const status = startStop[2] === "start" ? "RUNNING" : "TERMINATED";
      return this.operation(() => {
        resource.body["status"] = status;
      });
    }

    const metadata = /^instances\/([^/]+)\/setMetadata$/.exec(relative);
    if (args.method === "POST" && metadata?.[1] !== undefined) {
      const resource = this.live(this.instances, metadata[1]);
      if (resource === undefined) return { status: 404, body: {} };
      return this.operation(() => {
        resource.body["metadata"] = {
          ...(args.body ?? {}),
          fingerprint: `fp-${metadata[1]}-${this.nextOperation}`,
        };
      });
    }

    const disk = /^disks\/([^/?]+)$/.exec(relative);
    if (args.method === "GET" && disk?.[1] !== undefined) return this.get(this.disks, disk[1]);
    if (args.method === "DELETE" && disk?.[1] !== undefined) {
      const resource = this.live(this.disks, disk[1]);
      if (resource === undefined) return { status: 404, body: {} };
      return this.operation(() => {
        resource.deletionVisibilityRemaining = this.options.deletionVisibilityPolls;
      });
    }
    if (args.method === "POST" && relative === "disks") {
      const name = args.body?.["name"];
      if (typeof name !== "string") return { status: 400, body: {} };
      if (this.live(this.disks, name) !== undefined) return { status: 409, body: {} };
      return this.operation(() => {
        this.disks.set(name, {
          body: { ...(args.body ?? {}), name },
          deletionVisibilityRemaining: null,
        });
      });
    }

    return { status: 404, body: {} };
  }
}

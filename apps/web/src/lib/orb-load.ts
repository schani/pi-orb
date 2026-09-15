import type { OrbHistoryView, OrbView } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import type { ApiError } from "./api.ts";
import {
  type CachedTranscript,
  snapshotFromHistory,
  type TranscriptCache,
} from "./transcript-cache.ts";

export interface OrbLoad {
  orbId: string;
  orb: Result<OrbView, ApiError>;
  history: Result<CachedTranscript, ApiError>;
  cacheHit: boolean;
}

export function isMissing(error: ApiError): boolean {
  return error.type === "http" && error.status === 404;
}

/** One cancellable load owner. Cancellation fences publication, not just the selected orb ID. */
export function startOrbLoad(options: {
  orbId: string;
  cache: TranscriptCache;
  getOrb: (id: string) => Promise<Result<OrbView, ApiError>>;
  getHistory: (id: string) => Promise<Result<OrbHistoryView, ApiError>>;
  diagnostic?: (data: { orbId: string; cacheHit: boolean; records: number }) => void;
}): {
  result: Promise<OrbLoad | null>;
  accept(value: OrbLoad | null): OrbLoad | null;
  cancel(): void;
} {
  const { orbId, cache } = options;
  let active = true;
  let epoch = cache.invalidationEpoch;
  const accept = (value: OrbLoad | null): OrbLoad | null => {
    if (!active || value === null) return null;
    if (epoch === cache.invalidationEpoch) return value;
    const changed = err<never, ApiError>({
      type: "invalid_response",
      message: "Resources changed during navigation. Retry history.",
    });
    return { orbId, orb: changed, history: changed, cacheHit: false };
  };
  const cached = cache.get(orbId);
  // Preserve parallel cold reads. Hits need only fresh resource metadata before rendering.
  const metadata = options.getOrb(orbId);
  const history = cached === undefined ? options.getHistory(orbId) : null;
  const result = (async (): Promise<OrbLoad | null> => {
    const orb = await metadata;
    if (!active) return null;
    if ((orb.isErr() && isMissing(orb.error)) || (orb.isOk() && orb.value.state === "deleting")) {
      cache.invalidate(orbId);
      epoch = cache.invalidationEpoch;
      return {
        orbId,
        orb,
        history: err({ type: "invalid_response", message: "Orb history is unavailable" }),
        cacheHit: false,
      };
    }
    if (orb.isOk() && orb.value.id !== orbId) {
      const mismatch = err<never, ApiError>({
        type: "invalid_response",
        message: "Orb identity mismatch",
      });
      return { orbId, orb: mismatch, history: mismatch, cacheHit: false };
    }
    // A deletion/full-sync/eviction while metadata was in flight invalidates the original hit.
    const current = cached === undefined ? undefined : cache.get(orbId);
    let snapshot: Result<CachedTranscript, ApiError>;
    if (current !== undefined) snapshot = ok(current);
    else {
      const response = await (history ?? options.getHistory(orbId));
      if (!active) return null;
      if (response.isErr() && isMissing(response.error)) {
        cache.invalidate(orbId);
        epoch = cache.invalidationEpoch;
        return { orbId, orb: err(response.error), history: err(response.error), cacheHit: false };
      }
      snapshot = response.andThen((view) =>
        view.orbId === orbId
          ? ok(snapshotFromHistory(view))
          : err({ type: "invalid_response", message: "History identity mismatch" } as ApiError),
      );
    }
    if (!active) return null;
    options.diagnostic?.({
      orbId,
      cacheHit: current !== undefined,
      records: snapshot.isOk() ? snapshot.value.records.size : 0,
    });
    return { orbId, orb, history: snapshot, cacheHit: current !== undefined };
  })();
  return {
    result: result.then(accept),
    accept,
    cancel: () => {
      active = false;
    },
  };
}

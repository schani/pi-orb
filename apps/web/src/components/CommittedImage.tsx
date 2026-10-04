import { useEffect, useState } from "react";
import { getCommittedImage } from "../lib/api.ts";
import { createImageObjectUrl, revokeImageObjectUrl } from "../lib/object-url.ts";
import type { DetailContext } from "./DetailBody.tsx";
import { ToolImagePreview } from "./ToolImagePreview.tsx";

export function imageIndex(detailKey: string, ref: string): number | null {
  const prefix = `${detailKey}:`;
  const suffix = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  if (!/^(0|[1-9]\d*)$/.test(suffix)) return null;
  const index = Number(suffix);
  return Number.isSafeInteger(index) ? index : null;
}

/** A mounted view owns its URL; eviction only drops cache bytes, never a live URL. */
export function CommittedImage({
  context,
  recordId,
  detailKey,
  index,
  toolName,
}: {
  context: DetailContext;
  recordId: string;
  detailKey: string;
  index: number;
  toolName?: string;
}) {
  const { orbId, sessionId, cache, getOwner, imagePending } = context;
  const requestKey = JSON.stringify([orbId, sessionId, recordId, detailKey, index]);
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([requestKey, revision]);
  const [view, setView] = useState<{
    scope: string;
    src?: string;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (sessionId === null) return;
    let active = true;
    let url: string | undefined;
    const report = (outcome: string, extra: { bytes?: number; cacheBytes?: number } = {}) =>
      console.debug("display image", {
        orbId,
        recordId,
        detailKey,
        imageIndex: index,
        sessionId,
        outcome,
        ...extra,
      });
    const show = (blob: Blob) => {
      if (!active) return;
      const created = createImageObjectUrl(blob);
      if (created.isErr()) {
        report(created.error.type);
        setView({ scope, failed: true });
        return;
      }
      url = created.value;
      setView({ scope, src: url });
    };
    const cached = cache.getImage(orbId, sessionId, recordId, detailKey, index);
    if (cached !== undefined) {
      report("hit", { bytes: cached.size });
      show(cached);
    } else {
      const owner = getOwner();
      if (owner === null) return;
      const key = requestKey;
      let pending = imagePending.get(key);
      if (
        pending !== undefined &&
        (pending.epoch !== cache.invalidationEpoch || pending.owner !== owner)
      )
        pending = undefined;
      if (pending === undefined) {
        const epoch = cache.invalidationEpoch;
        pending = {
          request: getCommittedImage(orbId, recordId, detailKey, index, sessionId),
          owner,
          epoch,
        };
        imagePending.set(key, pending);
        report("miss");
        const started = pending;
        void started.request.then(() => {
          if (imagePending.get(key) === started) imagePending.delete(key);
        });
      } else {
        report("coalesced");
      }
      const { epoch } = pending;
      void pending.request.then((result) => {
        if (!active) return;
        if (cache.invalidationEpoch !== epoch) {
          report("stale_epoch");
          setView({ scope, failed: true });
          return;
        }
        if (result.isErr()) {
          report(result.error.type);
          setView({ scope, failed: true });
          return;
        }
        const admission = owner.publishImage({
          sessionId,
          recordId,
          detailKey,
          imageIndex: index,
          blob: result.value,
        });
        report(admission, { bytes: result.value.size, cacheBytes: cache.stats.bytes });
        if (admission === "stale") {
          setView({ scope, failed: true });
          return;
        }
        show(result.value);
      });
    }
    return () => {
      active = false;
      if (url !== undefined) {
        const revoked = revokeImageObjectUrl(url);
        if (revoked.isErr()) report(revoked.error.type);
      }
    };
  }, [
    orbId,
    sessionId,
    cache,
    getOwner,
    imagePending,
    scope,
    requestKey,
    recordId,
    detailKey,
    index,
  ]);
  const source = view?.scope === scope ? view.src : undefined;
  if (view?.scope === scope && view.failed)
    return (
      <span role="alert">
        image failed to load{" "}
        <button type="button" onClick={() => setRevision((current) => current + 1)}>
          Retry
        </button>
      </span>
    );
  if (toolName !== undefined)
    return source === undefined ? (
      <span role="status">Loading…</span>
    ) : (
      <ToolImagePreview src={source} toolName={toolName} />
    );
  return source === undefined ? (
    <span>Loading…</span>
  ) : (
    <img className="msg-image" src={source} alt="attachment" />
  );
}

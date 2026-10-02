import type {
  CommittedDisplayDetail,
  DisplayDetailBody,
  LiveDisplayDetail,
} from "@pi-orb/protocol";
import { err, type Result } from "neverthrow";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { describeApiError, getCommittedDetail, getLiveDetail } from "../lib/api.ts";
import { DetailLoader } from "../lib/detail-loader.ts";
import type { TranscriptCache, TranscriptOwner } from "../lib/transcript-cache.ts";
import { CommittedImage, imageIndex } from "./CommittedImage.tsx";
import { ToolImagePreview } from "./ToolImagePreview.tsx";

export interface DetailContext {
  orbId: string;
  sessionId: string | null;
  connected: boolean;
  operationId: string | null;
  cache: TranscriptCache;
  getOwner: () => TranscriptOwner | null;
  livePending: Map<string, Promise<Result<LiveDisplayDetail, string>>>;
  committedPending: Map<string, ReturnType<typeof getCommittedDetail>>;
  imagePending: Map<
    string,
    {
      request: ReturnType<typeof import("../lib/api.ts").getCommittedImage>;
      owner: TranscriptOwner | null;
      epoch: number;
    }
  >;
}

function Leaves({
  content,
  context,
  recordId,
  detailKey,
}: {
  content: Extract<DisplayDetailBody, { type: "tool_result" }>["content"];
  context: DetailContext;
  recordId: string;
  detailKey: string;
}) {
  return (
    <>
      {content.map((item, index) =>
        item.type === "image" ? (
          item.url !== undefined ? (
            <ToolImagePreview key={index} src={item.url} toolName="tool result" />
          ) : item.imageRef !== undefined && imageIndex(detailKey, item.imageRef) !== null ? (
            <CommittedImage
              key={index}
              context={context}
              recordId={recordId}
              detailKey={detailKey}
              index={imageIndex(detailKey, item.imageRef) ?? 0}
              toolName="tool result"
            />
          ) : (
            <ToolImagePreview key={index} toolName="tool result" />
          )
        ) : null,
      )}
    </>
  );
}

export function NestedSummary({
  nested,
}: {
  nested: NonNullable<Extract<DisplayDetailBody, { type: "tool_result" }>["nestedCalls"]>;
}) {
  return (
    <div className="tool-nested-calls">
      {nested.calls.map((child) => (
        <div className="tool-nested-call" key={child.id}>
          <span className={child.status === "error" ? "tool-activity-failed" : undefined}>
            {child.name} · {child.status}
            {child.durationMs !== undefined ? ` · ${child.durationMs} ms` : ""}
          </span>
          {child.arguments !== undefined && (
            <pre className="tool-call-output">{JSON.stringify(child.arguments, null, 2)}</pre>
          )}
          {child.argumentsBytes !== undefined && child.arguments === undefined && (
            <span>arguments omitted ({child.argumentsBytes} bytes)</span>
          )}
          {child.error !== undefined && (
            <pre className="tool-call-output tool-call-output-error">{child.error}</pre>
          )}
        </div>
      ))}
      {!nested.complete && <span className="tool-activity-running">incomplete</span>}
    </div>
  );
}

export function DetailContent({
  body,
  context,
  recordId,
  detailKey,
}: {
  body: DisplayDetailBody;
  context: DetailContext;
  recordId: string;
  detailKey: string;
}): ReactNode {
  switch (body.type) {
    case "reasoning":
      return <span>{body.text}</span>;
    case "tool_call":
      return <pre className="tool-input">{JSON.stringify(body.arguments, null, 2)}</pre>;
    case "tool_result":
      return (
        <>
          <pre className="tool-call-output">
            {body.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n")}
          </pre>
          <Leaves
            content={body.content}
            context={context}
            recordId={recordId}
            detailKey={detailKey}
          />
          {body.nestedCalls !== undefined && <NestedSummary nested={body.nestedCalls} />}
        </>
      );
    case "image":
      return body.url === undefined &&
        (body.imageRef === undefined || imageIndex(detailKey, body.imageRef) === null) ? (
        <span>[image]</span>
      ) : body.url !== undefined ? (
        <img className="msg-image" src={body.url} alt="attachment" />
      ) : (
        <CommittedImage
          context={context}
          recordId={recordId}
          detailKey={detailKey}
          index={imageIndex(detailKey, body.imageRef ?? "") ?? 0}
        />
      );
    case "compaction":
      return <span>{body.text}</span>;
    case "subagent":
      return (
        <span>
          {body.message ??
            body.notice ??
            body.error ??
            body.resultPreview ??
            "Notification details unavailable."}
        </span>
      );
  }
}

/** Mounted only while the owning disclosure is open. Failed reads remain scoped, with explicit retry. */
export function CommittedBody({
  context,
  recordId,
  detailKey,
  render,
}: {
  context: DetailContext;
  recordId: string;
  detailKey: string;
  render?: (body: DisplayDetailBody) => ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  const [body, setBody] = useState<{
    scope: string;
    value: DisplayDetailBody;
  } | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const { orbId, sessionId, cache, getOwner, committedPending } = context;
  const scope = JSON.stringify([orbId, sessionId, recordId, detailKey, revision]);
  useEffect(() => {
    setBody(null);
    setError(null);
    if (sessionId === null) return;
    const cached = cache.getDetail(orbId, sessionId, recordId, detailKey);
    if (cached !== undefined) {
      setBody({ scope, value: cached.body });
      return;
    }
    let active = true;
    const owner = getOwner();
    const epoch = cache.invalidationEpoch;
    const key = JSON.stringify([orbId, sessionId, recordId, detailKey]);
    let request = committedPending.get(key);
    if (request === undefined) {
      request = getCommittedDetail(orbId, recordId, detailKey, sessionId);
      committedPending.set(key, request);
      void request.then(() => {
        if (committedPending.get(key) === request) committedPending.delete(key);
      });
    }
    void request.then((result) => {
      if (!active || cache.invalidationEpoch !== epoch) return;
      if (result.isErr()) {
        console.debug("display detail", {
          orbId,
          recordId,
          detailKey,
          outcome: result.error.type,
        });
        setError({ scope, message: describeApiError(result.error) });
        return;
      }
      const detail: CommittedDisplayDetail = result.value;
      if (
        detail.sessionId !== sessionId ||
        detail.recordId !== recordId ||
        detail.detailKey !== detailKey ||
        owner === null
      ) {
        console.debug("display detail", {
          orbId,
          recordId,
          detailKey,
          outcome: "stale_identity",
        });
        setError({ scope, message: "Detail changed. Retry." });
        return;
      }
      const admission = owner.publishDetail(detail);
      console.debug("display detail", {
        orbId,
        recordId,
        detailKey,
        outcome: admission,
        bytes: cache.stats.bytes,
      });
      if (admission === "stale") {
        setError({ scope, message: "Detail changed. Retry." });
        return;
      }
      setBody({ scope, value: detail.body });
    });
    return () => {
      active = false;
    };
  }, [orbId, sessionId, cache, getOwner, recordId, detailKey, scope, committedPending]);
  if (error?.scope === scope)
    return (
      <p role="alert">
        {error.message}{" "}
        <button type="button" onClick={() => setRevision((current) => current + 1)}>
          Retry
        </button>
      </p>
    );
  if (body?.scope !== scope) return <span>Loading…</span>;
  return (
    <>
      {render ? (
        render(body.value)
      ) : (
        <DetailContent
          body={body.value}
          context={context}
          recordId={recordId}
          detailKey={detailKey}
        />
      )}
    </>
  );
}

/** Active snapshots stay local. The loader fences old operation and connection owners. */
export function RunningBody({
  context,
  blockId,
  command = false,
}: {
  context: DetailContext;
  blockId: string;
  command?: boolean;
}) {
  const [body, setBody] = useState<{
    scope: string;
    value: LiveDisplayDetail["body"];
  }>();
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const { orbId, sessionId, operationId, connected, livePending } = context;
  const scope = JSON.stringify([orbId, sessionId, operationId, blockId]);
  const loader = useMemo(
    () =>
      new DetailLoader<LiveDisplayDetail, string>({
        read: async () => {
          if (operationId === null || sessionId === null) return err("unavailable");
          const result = await getLiveDetail(orbId, operationId, blockId, sessionId);
          return result.mapErr(describeApiError);
        },
        shouldContinue: (detail) => detail.state === "running",
        pending: livePending,
        publish: (result) => {
          if (result.isErr()) {
            console.debug("live detail", { orbId, blockId, outcome: "error" });
            setError({ scope, message: result.error });
            return;
          }
          const detail = result.value;
          if (
            detail.sessionId !== sessionId ||
            detail.operationId !== operationId ||
            detail.blockId !== blockId
          )
            return;
          if (detail.state === "unavailable") {
            console.debug("live detail", {
              orbId,
              blockId,
              outcome: "unavailable",
            });
            setError({ scope, message: "Detail unavailable. Retry." });
            return;
          }
          if (detail.state === "completed")
            console.debug("live detail", {
              orbId,
              blockId,
              outcome: "completed",
            });
          setBody({ scope, value: detail.body });
          setError(null);
        },
      }),
    [orbId, sessionId, operationId, blockId, livePending, scope],
  );
  useEffect(() => {
    if (!connected) {
      setBody(undefined);
      setError(null);
    }
    if (connected && operationId !== null)
      loader.open(JSON.stringify([orbId, sessionId, operationId, blockId]), true);
    return () => loader.close();
  }, [loader, connected, operationId, blockId, sessionId, orbId]);
  if (!connected) return <span>Disconnected</span>;
  if (error?.scope === scope)
    return (
      <p role="alert">
        {error.message}{" "}
        <button type="button" onClick={() => loader.retry()}>
          Retry
        </button>
      </p>
    );
  const current = body?.scope === scope ? body.value : undefined;
  return (
    <pre className="tool-call-output">
      {current?.type === "tool_result"
        ? [
            current.arguments === undefined
              ? ""
              : command &&
                  typeof current.arguments === "object" &&
                  current.arguments !== null &&
                  !Array.isArray(current.arguments)
                ? typeof current.arguments.command === "string"
                  ? current.arguments.command
                  : ""
                : JSON.stringify(current.arguments, null, 2),
            current.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n")
        : current !== undefined && "text" in current
          ? current.text
          : ""}
    </pre>
  );
}

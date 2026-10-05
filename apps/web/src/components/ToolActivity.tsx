import { capHeadline, type DisplayBlock, type DisplayDetailBody } from "@pi-orb/protocol";
import { type ReactNode, useState } from "react";
import { type ActivityHeadlineSource, selectToolHeadline } from "../lib/activity-headline.ts";
import { useActivityHeadline } from "../lib/use-activity-headline.tsx";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { CommittedImage, imageIndex } from "./CommittedImage.tsx";
import { CommittedBody, type DetailContext, NestedSummary, RunningBody } from "./DetailBody.tsx";
import { ToolImagePreview } from "./ToolImagePreview.tsx";

export type ToolCallBlock = Extract<DisplayBlock, { type: "tool_call" }>;
export type ToolResultBlock = Extract<DisplayBlock, { type: "tool_result" }>;
export interface PersistedToolCall {
  call: ToolCallBlock;
  callRecordId: string;
  result?: ToolResultBlock;
  resultRecordId?: string;
}
export interface LiveToolCall {
  callId: string;
  name: string;
  state: "running" | "completed" | "failed";
}
interface Call {
  id: string;
  name: string;
  headline: string;
  headlineSource?: ActivityHeadlineSource;
  targetId?: string;
  callRecordId?: string;
  callKey?: string;
  resultRecordId?: string;
  result?: ToolResultBlock;
  offset?: number;
  limit?: number;
  state: "running" | "completed" | "failed";
}
type Kind = "edit" | "command" | "read" | "other";
interface Category {
  key: string;
  kind: Kind;
  label: string;
  calls: Call[];
}
function categoryFor(name: string): Omit<Category, "calls"> {
  if (name === "edit" || name === "write") return { key: "edit", kind: "edit", label: "edit" };
  if (name === "bash") return { key: "command", kind: "command", label: "commands" };
  if (name === "read") return { key: "read", kind: "read", label: "read" };
  return { key: `other:${name}`, kind: "other", label: name };
}
function categorize(calls: readonly Call[]): Category[] {
  const categories = new Map<string, Category>();
  for (const call of calls) {
    const descriptor = categoryFor(call.name);
    const category = categories.get(descriptor.key);
    if (category) category.calls.push(call);
    else categories.set(descriptor.key, { ...descriptor, calls: [call] });
  }
  return [...categories.values()];
}
function displayCategories(calls: readonly Call[]): Category[] {
  if (!calls.some((call) => call.result?.hasImages)) return categorize(calls);
  const categories: Category[] = [];
  let textCalls: Call[] = [];
  const flush = () => {
    categories.push(
      ...categorize(textCalls).map((category) => ({
        ...category,
        key: `${category.key}:segment:${category.calls[0]?.id ?? "empty"}`,
      })),
    );
    textCalls = [];
  };
  for (const call of calls) {
    if (!call.result?.hasImages) {
      textCalls.push(call);
      continue;
    }
    flush();
    categories.push({
      ...categoryFor(call.name),
      key: `image:${call.id}`,
      calls: [call],
    });
  }
  flush();
  return categories;
}
function uniqueCount(calls: readonly Call[]): number {
  const targets = new Set(
    calls.map((call) => call.targetId).filter((value): value is string => value !== undefined),
  );
  return targets.size || calls.length;
}
function metric(category: Category): ReactNode {
  const failures = category.calls.filter((call) => call.state === "failed").length;
  const running = category.calls.some((call) => call.state === "running");
  const added = category.calls.reduce((sum, call) => sum + (call.result?.added ?? 0), 0);
  const removed = category.calls.reduce((sum, call) => sum + (call.result?.removed ?? 0), 0);
  const diff =
    category.kind === "edit" &&
    category.calls.some(
      (call) => call.result?.added !== undefined || call.result?.removed !== undefined,
    );
  const count =
    category.kind === "read" || category.kind === "edit"
      ? uniqueCount(category.calls)
      : category.calls.length;
  const lead = diff ? (
    <>
      <span className="tool-diff-added">+{added}</span>{" "}
      <span className="tool-diff-removed">−{removed}</span>
    </>
  ) : count > 1 ? (
    `${count} ${category.kind === "command" ? "ran" : category.kind === "other" ? "calls" : "files"}`
  ) : null;
  const trail = failures ? (
    <span className="tool-activity-failed">{failures} failed</span>
  ) : running ? (
    <span className="tool-activity-running">running</span>
  ) : null;
  return lead === null ? (
    trail
  ) : trail === null ? (
    lead
  ) : (
    <>
      {lead} · {trail}
    </>
  );
}
function headline(category: Category): string | undefined {
  const first = category.calls[0];
  if (!first) return undefined;
  if (category.kind === "other") return undefined;
  if (category.kind === "read")
    return category.calls.length === 1
      ? boundedReadLabel(first)
      : uniqueCount(category.calls) === 1
        ? first.headline
        : undefined;
  return category.calls.length === 1 ? first.headline : undefined;
}
function boundedReadLabel(call: Call): string {
  if (call.offset === undefined && call.limit === undefined) return call.headline;
  const start = call.offset ?? 1;
  const range = `:${start}${call.limit === undefined ? "+" : `–${start + call.limit - 1}`}`;
  const encoder = new TextEncoder();
  const budget = 1024 - encoder.encode(range).length;
  const headline = call.headline;
  let path = "";
  let bytes = 0;
  for (const char of headline) {
    const size = encoder.encode(char).length;
    if (bytes + size > budget - 3) return `${path}…${range}`;
    path += char;
    bytes += size;
  }
  return `${path}${range}`;
}
function headlineSource(call: Call, kind: Kind): ActivityHeadlineSource | undefined {
  const source = call.headlineSource;
  return kind === "read" &&
    source !== undefined &&
    source.detailKey === call.callKey &&
    typeof source.headline === "string"
    ? { ...source, headline: boundedReadLabel(call) }
    : source;
}
function ReadBody({ call, context, kind }: { call: Call; context: DetailContext; kind: Kind }) {
  const render = (body: DisplayDetailBody) =>
    body.type === "tool_result" &&
    body.nestedCalls === undefined &&
    body.content.every(
      (item) => item.type !== "image" && (item.type !== "text" || item.text === ""),
    ) &&
    call.callRecordId &&
    call.callKey &&
    kind !== "command" ? (
      <CommittedBody
        context={context}
        recordId={call.callRecordId}
        detailKey={call.callKey}
        render={(input) =>
          input.type === "tool_call" ? (
            <pre className="tool-input">{JSON.stringify(input.arguments, null, 2)}</pre>
          ) : null
        }
      />
    ) : body.type === "tool_result" ? (
      <>
        <pre
          className={
            call.state === "failed" ? "tool-call-output tool-call-output-error" : "tool-call-output"
          }
        >
          {body.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n")}
        </pre>
        {body.content.map((item, index) =>
          item.type === "image" &&
          call.resultRecordId !== undefined &&
          call.result !== undefined ? (
            item.url !== undefined ? (
              <ToolImagePreview key={index} src={item.url} toolName={call.name} />
            ) : item.imageRef !== undefined &&
              imageIndex(call.result.detailKey, item.imageRef) !== null ? (
              <CommittedImage
                key={index}
                context={context}
                recordId={call.resultRecordId}
                detailKey={call.result.detailKey}
                index={imageIndex(call.result.detailKey, item.imageRef) ?? 0}
                toolName={call.name}
              />
            ) : (
              <ToolImagePreview key={index} toolName={call.name} />
            )
          ) : null,
        )}
        {body.nestedCalls !== undefined && <NestedSummary nested={body.nestedCalls} />}
      </>
    ) : null;
  if (context.operationId && call.state === "running")
    return <RunningBody context={context} blockId={call.id} command={kind === "command"} />;
  if (call.result && call.resultRecordId && kind !== "other")
    return (
      <CommittedBody
        context={context}
        recordId={call.resultRecordId}
        detailKey={call.result.detailKey}
        render={render}
      />
    );
  if (kind === "command" && !call.result) return null;
  if (call.callRecordId && call.callKey)
    return (
      <CommittedBody
        context={context}
        recordId={call.callRecordId}
        detailKey={call.callKey}
        render={(body) => (
          <>
            {body.type === "tool_call" && (
              <pre className="tool-input">{JSON.stringify(body.arguments, null, 2)}</pre>
            )}
            {call.result && call.resultRecordId ? (
              <CommittedBody
                context={context}
                recordId={call.resultRecordId}
                detailKey={call.result.detailKey}
                render={render}
              />
            ) : null}
          </>
        )}
      />
    );
  return null;
}
function CallBody({ call, kind, context }: { call: Call; kind: Kind; context: DetailContext }) {
  return (
    <div className={kind === "command" ? "tool-command" : undefined}>
      {kind === "command" && !(call.state === "running" && context.operationId) && (
        <div className="tool-command-line">
          <span className="rec-px">run</span>
          <span className="tool-command-text">
            {call.callRecordId && call.callKey ? (
              <CommittedBody
                context={context}
                recordId={call.callRecordId}
                detailKey={call.callKey}
                render={(body) =>
                  body.type === "tool_call" &&
                  typeof body.arguments === "object" &&
                  body.arguments !== null &&
                  !Array.isArray(body.arguments) &&
                  typeof body.arguments.command === "string"
                    ? body.arguments.command
                    : call.headline
                }
              />
            ) : (
              call.headline
            )}
          </span>
        </div>
      )}
      <ReadBody call={call} context={context} kind={kind} />
      {kind === "command" && (
        <div className="tool-command-footer">
          {call.state === "failed"
            ? "✕ failed"
            : call.state === "running"
              ? "◐ running"
              : "✓ completed"}
        </div>
      )}
    </div>
  );
}
function callLabel(call: Call, kind: Kind): string {
  return kind === "read" ? boundedReadLabel(call) : call.headline || capHeadline(call.name);
}
type CallRowProps = {
  call: Call;
  kind: Kind;
  context: DetailContext;
  categoryOpen: boolean;
};
function OwnedCallRow(props: CallRowProps) {
  const summary = useActivityHeadline(
    headlineSource(props.call, props.kind),
    props.context,
    callLabel(props.call, props.kind),
  );
  return <CallRow {...props} summary={summary} />;
}
function CallRow({
  call,
  kind,
  context,
  categoryOpen,
  summary,
}: CallRowProps & { summary: ReturnType<typeof useActivityHeadline> }) {
  const [open, setOpen] = useState(call.result?.hasImages === true);
  const stats =
    call.result?.added === undefined && call.result?.removed === undefined ? null : (
      <>
        <span className="tool-diff-added">+{call.result.added ?? 0}</span>{" "}
        <span className="tool-diff-removed">−{call.result.removed ?? 0}</span>
      </>
    );
  return (
    <details
      className="tool-activity-call"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary ref={summary.headerRef}>
        <span className="tool-call-marker">·</span>
        <code
          className="trunc"
          title={typeof summary.headline === "string" ? summary.headline : undefined}
        >
          {summary.headline}
        </code>
        {kind !== "read" && (
          <span className={`tool-call-status tool-call-${call.state}`}>
            {stats ??
              (call.state === "failed"
                ? "failed"
                : call.state === "running"
                  ? "running"
                  : "complete")}
          </span>
        )}
      </summary>
      {open && categoryOpen && <CallBody call={call} kind={kind} context={context} />}
    </details>
  );
}
function CategoryRow({ category, context }: { category: Category; context: DetailContext }) {
  const image = category.calls.length === 1 && category.calls[0]?.result?.hasImages;
  const [open, setOpen] = useState(image === true);
  const first = category.calls[0];
  const single = category.calls.length === 1;
  const summary = useActivityHeadline(
    first ? headlineSource(first, category.kind) : undefined,
    context,
    single ? headline(category) : first ? callLabel(first, category.kind) : undefined,
  );
  const categoryHeadline = single ? summary.headline : headline(category);
  return (
    <ActivityRailRow
      className={image ? "tool-activity-category tool-image-activity" : "tool-activity-category"}
      label={category.label}
      {...(single ? { headerRef: summary.headerRef } : {})}
      {...(categoryHeadline !== undefined ? { headline: categoryHeadline } : {})}
      {...(metric(category) !== null ? { metric: metric(category) } : {})}
      state={
        category.calls.some((call) => call.state === "failed")
          ? "failed"
          : category.calls.some((call) => call.state === "running")
            ? "running"
            : "completed"
      }
      defaultOpen={image === true}
      onToggle={setOpen}
    >
      <div className="tool-activity-calls">
        {category.calls.map((call) =>
          category.calls.length === 1 ? (
            open && <CallBody key={call.id} call={call} kind={category.kind} context={context} />
          ) : call === first ? (
            <CallRow
              key={call.id}
              call={call}
              kind={category.kind}
              context={context}
              categoryOpen={open}
              summary={summary}
            />
          ) : (
            <OwnedCallRow
              key={call.id}
              call={call}
              kind={category.kind}
              context={context}
              categoryOpen={open}
            />
          ),
        )}
      </div>
    </ActivityRailRow>
  );
}

export function ToolActivity({
  persisted = [],
  live = [],
  detailContext,
}: {
  persisted?: readonly PersistedToolCall[];
  live?: readonly LiveToolCall[];
  detailContext: DetailContext;
}) {
  const calls: Call[] = [
    ...persisted.map(({ call, callRecordId, result, resultRecordId }) => ({
      id: call.callId,
      name: call.name,
      headline: call.headline ?? "",
      headlineSource: selectToolHeadline(call, callRecordId, result, resultRecordId),
      targetId: call.targetId,
      offset: call.offset,
      limit: call.limit,
      callRecordId,
      callKey: call.detailKey,
      ...(result ? { result } : {}),
      ...(resultRecordId ? { resultRecordId } : {}),
      state:
        result === undefined
          ? ("running" as const)
          : result.isError
            ? ("failed" as const)
            : ("completed" as const),
    })),
    ...live.map((call) => ({
      id: call.callId,
      name: call.name,
      headline: call.name,
      state: call.state,
    })),
  ];
  if (calls.length === 0) return null;
  return (
    <>
      {displayCategories(calls).map((category) => (
        <CategoryRow key={category.key} category={category} context={detailContext} />
      ))}
    </>
  );
}

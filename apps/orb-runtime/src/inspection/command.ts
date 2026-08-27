import type {
  ContentBlock,
  HistoryRecord,
  OrbInspectionItem,
  OrbTranscript,
} from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";

export const INSPECTION_USAGE = `usage:
  pi-orb orbs [query] [--json]
  pi-orb transcript <orb-id> [--json]
  pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]`;

export type InspectionCommand =
  | { readonly type: "orbs"; readonly query: string | null; readonly json: boolean }
  | { readonly type: "transcript"; readonly orbId: string; readonly json: boolean };

export function parseInspectionArgs(argv: readonly string[]): Result<InspectionCommand, string> {
  const jsonCount = argv.filter((argument) => argument === "--json").length;
  if (jsonCount > 1) return err(`--json given twice\n${INSPECTION_USAGE}`);
  const args = argv.filter((argument) => argument !== "--json");
  const [subcommand, ...operands] = args;
  if (subcommand === "orbs" && operands.length <= 1) {
    return ok({ type: "orbs", query: operands[0] ?? null, json: jsonCount === 1 });
  }
  const transcriptOrbId = operands[0];
  if (
    subcommand === "transcript" &&
    operands.length === 1 &&
    transcriptOrbId !== undefined &&
    transcriptOrbId !== ""
  ) {
    return ok({ type: "transcript", orbId: transcriptOrbId, json: jsonCount === 1 });
  }
  return err(`invalid pi-orb command\n${INSPECTION_USAGE}`);
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function filterOrbs(
  items: readonly OrbInspectionItem[],
  query: string | null,
): OrbInspectionItem[] {
  const needle = query === null ? "" : normalize(query);
  if (needle === "") return [...items];
  return items.filter((item) =>
    [
      item.id,
      item.name ?? "untitled orb",
      item.project.id,
      item.project.name,
      item.project.repositoryUrl,
    ].some((field) => normalize(field).includes(needle)),
  );
}

function cell(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function formatOrbList(items: readonly OrbInspectionItem[], currentOrbId: string): string {
  const rows = ["CURRENT\tORB ID\tNAME\tSTATE\tPROJECT\tREPOSITORY"];
  for (const item of items) {
    rows.push(
      [
        item.id === currentOrbId ? "*" : "",
        item.id,
        item.name ?? "untitled orb",
        item.state,
        item.project.name,
        item.project.repositoryUrl,
      ]
        .map(cell)
        .join("\t"),
    );
  }
  return `${rows.join("\n")}\n`;
}

function renderBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "reasoning":
        parts.push(`[reasoning]\n${block.redacted === true ? "[redacted]" : block.text}`);
        break;
      case "image":
        parts.push(`[image${block.mediaType === undefined ? "" : `: ${block.mediaType}`}]`);
        break;
      case "tool_call":
        parts.push(`[tool call: ${block.name}]\n${JSON.stringify(block.arguments)}`);
        break;
      case "tool_result":
        parts.push(`[tool result: ${block.callId}]\n${renderBlocks(block.content)}`);
        break;
      case "other":
        parts.push(`[${block.contentType}]\n${JSON.stringify(block.data)}`);
        break;
    }
  }
  return parts.join("\n\n");
}

function renderRecord(record: HistoryRecord): string {
  if (record.type === "message") {
    return `## ${record.role ?? "message"}\n\n${renderBlocks(record.content)}`;
  }
  if (record.type === "compaction") {
    return `## compaction\n\n${renderBlocks(record.summary)}`;
  }
  return `## event: ${record.eventType}${
    record.content === undefined ? "" : `\n\n${renderBlocks(record.content)}`
  }`;
}

export function formatTranscript(transcript: OrbTranscript): string {
  const title = transcript.orb.name ?? "untitled orb";
  const preamble = [
    `# ${title} (${transcript.orb.id})`,
    "",
    `Project: ${transcript.orb.project.name} (${transcript.orb.project.id})`,
    `Repository: ${transcript.orb.project.repositoryUrl}`,
    `State: ${transcript.orb.state}`,
  ];
  if (transcript.records.length === 0) {
    return `${preamble.join("\n")}\n\n_No replicated transcript records._\n`;
  }
  return `${preamble.join("\n")}\n\n${transcript.records.map(renderRecord).join("\n\n")}\n`;
}

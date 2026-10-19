import type { ResultAsync } from "neverthrow";

export const MAX_CONTENT_BYTES = 1_048_576;
export type ErrorCode =
  | "unsupported"
  | "not_found"
  | "read_only"
  | "conflict"
  | "syntax"
  | "unsafe_path"
  | "too_large"
  | "invalid_request"
  | "io"
  | "unauthorized"
  | "forbidden";
export type PromptError = { [C in ErrorCode]: { code: C; message: string } }[ErrorCode];
export type AstPath = readonly (string | number)[];
export type CodeOwner =
  | { kind: "variable"; name: string }
  | { kind: "function"; name: string }
  | { kind: "tool"; name: string }
  | { kind: "property"; name: string };
export type ExtractionSelector =
  | { kind: "markdown" | "markdown-body" | "frontmatter-description" }
  | {
      kind: "code";
      owner?: CodeOwner;
      /** Structural child path from owner (variable starts at initializer; tool at description). */
      path?: AstPath;
      /** Exact expression kind; ordinal selects a descendant in source order, zero-based. */
      node: "string" | "template" | "joined-array";
      ordinal?: number;
      /** Friendly names, one per dynamic expression, in source order. */
      variables?: readonly string[];
    };
export interface Definition {
  id: string;
  title: string;
  category: string;
  scope: string;
  path: string;
  editable: boolean;
  selector?: ExtractionSelector;
  note?: string;
  content?: string;
  packagePath?: string;
}
export interface Entry {
  id: string;
  title: string;
  category: string;
  scope: string;
  editable: boolean;
  content: string;
  revision: string;
  note?: string;
  variables?: string[];
}
export interface Draft {
  id: string;
  content: string;
  revision: string;
}
export interface RenderConfig {
  harness: "pi" | "claude";
  role: "root" | "subagent";
  timeZone: string | null;
}
export interface RenderSnapshot {
  entries: Entry[];
  resources: { path: string; content: string }[];
}
export interface Source {
  snapshot?(
    catalog: readonly Definition[],
    drafts: readonly Draft[],
  ): ResultAsync<RenderSnapshot, PromptError>;
  read(definition: Definition): ResultAsync<Entry, PromptError>;
  save(definition: Definition, content: string, revision: string): ResultAsync<Entry, PromptError>;
  asset(path: string): ResultAsync<Buffer, PromptError>;
}

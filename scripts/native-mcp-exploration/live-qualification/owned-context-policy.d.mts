export interface ContextRecord {
  profile: string;
  phase: string;
  kind: string;
  status: string;
  utf8Bytes: number | null;
  codepoints: number | null;
  activeMcpToolCount: number;
}
export declare function contextToolPolicy(): (name: string, input: unknown) => boolean;
export declare function summarizeContextRecords(records: readonly ContextRecord[]): ContextRecord[];
export declare function failureDiagnostic(
  state: {
    started: Set<string>;
    searches: Record<string, Record<string, number>>;
    denied: Record<string, number>;
    deniedCategories: Record<string, Record<string, number>>;
    deniedSearchShapes: Record<string, Record<string, boolean>>;
    completed: Record<string, boolean>;
    modelVerified: Record<string, boolean>;
    discovered: Record<string, Record<string, number>>;
    records: readonly ContextRecord[];
  },
  stage: string,
): object;
export declare function deniedSearchShape(args: unknown): {
  queryMatchesPolicy: boolean;
  queryObserved: boolean;
  hasLimit: boolean;
  onlyQueryAndLimit: boolean;
  limitValid: boolean;
};

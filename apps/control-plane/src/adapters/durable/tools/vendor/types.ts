import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
export interface ToolNamespace {
  name: string;
  description?: string;
  instructions?: string;
}
export interface PolicyTool {
  name: string;
  description: string;
  parameters: unknown;
  outputSchema?: CodemodeJsonSchema;
}

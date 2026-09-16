// Both scopes share the exact same Markdown/snapshot contract.
export {
  type PersonalInstructions as ProjectInstructions,
  PersonalInstructionsSchema as ProjectInstructionsSchema,
  PersonalInstructionsWriteSchema as ProjectInstructionsWriteSchema,
  validatePersonalInstructions as validateProjectInstructions,
} from "./personal-instructions.ts";

export const PROJECT_INSTRUCTIONS_PATH = "/api/v1/projects/:projectId/instructions";
export const PROJECT_INSTRUCTIONS_RUNTIME_PATH = "/runtime/v1/project-instructions";

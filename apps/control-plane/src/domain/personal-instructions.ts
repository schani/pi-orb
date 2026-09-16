import { type PersonalInstructions, validatePersonalInstructions } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";

export interface PersonalInstructionsError {
  readonly type: "personal_instructions_error";
  readonly code: "invalid" | "unavailable" | "internal";
  readonly message: string;
}
export interface PersonalInstructionsStore {
  read(
    task: SimulationTask,
    userId: string,
  ): ResultAsync<PersonalInstructions, PersonalInstructionsError>;
  /** One atomic durable assignment; returned revision/content belong to that assignment. */
  replace(
    task: SimulationTask,
    userId: string,
    content: string,
  ): ResultAsync<PersonalInstructions, PersonalInstructionsError>;
}
export const readPersonalInstructions = (
  task: SimulationTask,
  store: PersonalInstructionsStore,
  userId: string,
) => store.read(task, userId);
export function savePersonalInstructions(
  task: SimulationTask,
  store: PersonalInstructionsStore,
  userId: string,
  body: unknown,
) {
  const content = validatePersonalInstructions(body);
  return content.isErr()
    ? errAsync<PersonalInstructions, PersonalInstructionsError>({
        type: "personal_instructions_error",
        code: "invalid",
        message: content.error.message,
      })
    : store.replace(task, userId, content.value);
}

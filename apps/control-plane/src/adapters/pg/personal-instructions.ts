import {
  type PersonalInstructions,
  PersonalInstructionsSchema,
  validatePersonalInstructions,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { StoreError } from "../../domain/errors.ts";
import type {
  PersonalInstructionsError,
  PersonalInstructionsStore,
} from "../../domain/personal-instructions.ts";
import type { PgQueryResult, PostgreSQLClient } from "./client.ts";

const unavailable = (error?: StoreError): PersonalInstructionsError => ({
  type: "personal_instructions_error",
  code: error?.code === "unavailable" ? "unavailable" : "internal",
  message:
    error?.code === "unavailable"
      ? "Personal instructions unavailable"
      : "Personal instructions storage is inconsistent",
});

function snapshot(result: PgQueryResult) {
  const row = result.rows[0];
  const value = { content: row?.["content"], revision: Number(row?.["revision"]) };
  return Check(PersonalInstructionsSchema, value) &&
    validatePersonalInstructions({ content: value.content }).isOk()
    ? ok<PersonalInstructions, PersonalInstructionsError>(value)
    : err<PersonalInstructions, PersonalInstructionsError>(unavailable());
}

export class PostgreSQLPersonalInstructionsStore implements PersonalInstructionsStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  read(_task: SimulationTask): ResultAsync<PersonalInstructions, PersonalInstructionsError> {
    return this.db
      .query("SELECT content, revision FROM personal_instructions WHERE singleton = true")
      .mapErr(unavailable)
      .andThen(snapshot);
  }
  replace(
    _task: SimulationTask,
    content: string,
  ): ResultAsync<PersonalInstructions, PersonalInstructionsError> {
    return this.db
      .query(
        "UPDATE personal_instructions SET content = $1, revision = revision + 1, updated_at = now() WHERE singleton = true RETURNING content, revision",
        [content],
      )
      .mapErr(unavailable)
      .andThen(snapshot);
  }
}

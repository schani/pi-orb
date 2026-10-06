import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { fenceModels } from "./model-fence.ts";

it("rejects a stale owner before model provider dispatch", async () => {
  const models = createModels();
  const faux = fauxProvider();
  let dispatched = 0;
  faux.setResponses([
    () => {
      dispatched++;
      return fauxAssistantMessage("forbidden");
    },
  ]);
  models.setProvider(faux.provider);
  const fenced = fenceModels(models, () =>
    errAsync({
      type: "runtime_client_error",
      code: "cancelled",
      answered: true,
      retryable: false,
      message: "ownership revoked",
    }),
  );
  const model = models.getModel("faux", "faux-1")!;
  const answer = await fenced.completeSimple(model, { messages: [] });
  expect(answer.stopReason).toBe("error");
  expect(dispatched).toBe(0);
  expect(answer.errorMessage).not.toContain("forbidden");
});

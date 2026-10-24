import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect } from "vitest";

export function nativeCall(name: string, args: Record<string, unknown>, id = name) {
  return fauxToolCall(
    "codemode",
    { code: `text(await tools.${name}(${JSON.stringify(args)}));` },
    { id },
  );
}
export function nativeData(
  result: { content: readonly { type: string; text?: string }[] } | undefined,
) {
  expect(result?.content[0]).toMatchObject({
    type: "text",
    text: expect.stringMatching(/^Script completed\n/),
  });
  const body = result?.content[1];
  expect(body?.type).toBe("text");
  return JSON.parse(body?.text ?? "");
}

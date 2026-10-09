import { expect, it } from "vitest";
import { messageBatchId, squashMessageBatch } from "./message-batch.ts";

it("binds batch identity to ordered immutable membership and changes it when a member is cancelled", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const original = messageBatchId([first, second]);
  expect(original).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  expect(messageBatchId([first, second])).toBe(original);
  expect(messageBatchId([second, first])).not.toBe(original);
  expect(messageBatchId([first])).toBe(first);
  expect(messageBatchId([second])).toBe(second);
  expect(original).not.toBe(first);
  expect(original).not.toBe(second);
});

it("canonicalizes text boundaries without changing image bytes or metadata", () => {
  const image = { type: "image" as const, data: "aGVsbG8=", mediaType: "image/png" };
  expect(
    squashMessageBatch([
      {
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      { content: [image, { type: "text", text: "c" }] },
    ]),
  ).toEqual([{ type: "text", text: "ab\n\n" }, image, { type: "text", text: "c" }]);
  expect(
    squashMessageBatch([{ content: [image] }, { content: [{ type: "text", text: "next" }] }]),
  ).toEqual([image, { type: "text", text: "\n\nnext" }]);
});

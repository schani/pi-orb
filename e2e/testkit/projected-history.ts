import {
  type HistoryRecord,
  projectDisplayRecord,
  projectRecordDetail,
  projectRecordImage,
} from "@pi-orb/protocol";
import type { Page } from "@playwright/test";

/** Browser-side synthetic records still use the same projector and detail manifest as real history. */
export async function projectFixtureHistory(
  page: Page,
  orbId: string,
  records: readonly HistoryRecord[],
): Promise<ReturnType<typeof projectDisplayRecord>[]> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const prefix = `/api/v1/orbs/${orbId}`;
  await page.route(`**${prefix}/details/**`, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(`${prefix}/details/`.length).split("/");
    const recordId = decodeURIComponent(path[0] ?? "");
    const key = decodeURIComponent(path[1] ?? "");
    const record = byId.get(recordId);
    if (record === undefined) return route.continue();
    const body = projectRecordDetail(record, key);
    if (body === null)
      return route.fulfill({
        status: 404,
        json: { error: { code: "not_found", message: "Detail missing", retryable: false } },
      });
    return route.fulfill({
      json: {
        v: 1,
        sessionId: url.searchParams.get("sessionId"),
        recordId,
        detailKey: key,
        state: "committed",
        body,
      },
    });
  });
  await page.route(`**${prefix}/images/**`, (route) => {
    const url = new URL(route.request().url());
    const [id, key, index] = url.pathname.slice(`${prefix}/images/`.length).split("/");
    const record = byId.get(decodeURIComponent(id ?? ""));
    if (record === undefined) return route.continue();
    const image = projectRecordImage(record, decodeURIComponent(key ?? ""), Number(index));
    if (image === null) return route.fulfill({ status: 404, body: "image unavailable" });
    return route.fulfill({ contentType: image.mediaType, body: Buffer.from(image.data, "base64") });
  });
  return records.map(projectDisplayRecord);
}

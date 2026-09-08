import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import {
  generatedDigest,
  generatedSource,
  hostedByteStoreContract,
} from "./byte-store.contract.ts";
import { createGcsHostedByteStore } from "./gcs.ts";

const task = new NoSimulationTask("gcs hosting adapter test", false);
const context = () => ({ signal: new AbortController().signal });

class GcsModel {
  readonly sessions = new Map<
    string,
    { body: Uint8Array[]; cancelled: boolean; key: string; metadata: Record<string, string> }
  >();
  readonly objects = new Map<
    string,
    { chunks: Uint8Array[]; generation: string; key: string; metadata: Record<string, string> }
  >();
  largestRequest = 0;
  loseFinalResponse = false;
  shortAcknowledge = false;
  initiationStatus: number | undefined;
  truncateReads = false;
  finalCommitted: (() => void) | undefined;
  finalResponseGate: Promise<void> | undefined;
  sequence = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    this.largestRequest = Math.max(this.largestRequest, body.byteLength);
    if (url.pathname.startsWith("/upload/storage/v1/b/") && method === "POST") {
      if (this.initiationStatus !== undefined)
        return new Response("secret provider response", { status: this.initiationStatus });
      const request = JSON.parse(String(init?.body)) as { metadata: Record<string, string> };
      const id = `upload-${++this.sequence}`;
      const key = url.searchParams.get("name") ?? "";
      this.sessions.set(id, { body: [], cancelled: false, key, metadata: request.metadata });
      return new Response(null, {
        headers: { location: `https://storage.googleapis.test/session/${id}` },
        status: 200,
      });
    }
    if (url.hostname === "storage.googleapis.test") {
      const session = this.sessions.get(url.pathname.split("/").at(-1) ?? "");
      if (session === undefined || session.cancelled) return new Response(null, { status: 410 });
      if (method === "DELETE") {
        session.cancelled = true;
        return new Response(null, { status: 499 });
      }
      const range = new Headers(init?.headers).get("content-range") ?? "";
      if (body.byteLength === 0 && range.startsWith("bytes */")) {
        const object = this.objects.get(session.key);
        return object === undefined
          ? new Response(null, { status: 308 })
          : Response.json(this.metadata(object));
      }
      session.body.push(body.slice());
      if (!range.includes("/")) return new Response(null, { status: 400 });
      const final =
        !range.endsWith("/*") &&
        Number(range.split("/")[1]) ===
          session.body.reduce((sum, part) => sum + part.byteLength, 0);
      if (!final) {
        const received = session.body.reduce((sum, part) => sum + part.byteLength, 0);
        const acknowledged = this.shortAcknowledge ? received - 2 : received - 1;
        return new Response(null, {
          headers: { range: `bytes=0-${acknowledged}` },
          status: 308,
        });
      }
      const object = {
        chunks: session.body.map((part) => part.slice()),
        generation: String(++this.sequence),
        key: session.key,
        metadata: session.metadata,
      };
      this.objects.set(session.key, object);
      this.finalCommitted?.();
      if (this.finalResponseGate !== undefined) await this.finalResponseGate;
      if (this.loseFinalResponse) {
        this.loseFinalResponse = false;
        return Promise.reject(new Error("lost final response"));
      }
      return Response.json(this.metadata(object));
    }
    const key = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
    const object = this.objects.get(key);
    const generation = url.searchParams.get("generation");
    if (object === undefined || (generation !== null && generation !== object.generation))
      return new Response(null, { status: 404 });
    if (method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("alt") === "media") {
      let index = 0;
      const chunks = this.truncateReads
        ? object.chunks.map((chunk, chunkIndex) =>
            chunkIndex === object.chunks.length - 1
              ? chunk.subarray(0, chunk.byteLength - 1)
              : chunk,
          )
        : object.chunks;
      return new Response(
        new ReadableStream({
          pull: (controller) => {
            const chunk = chunks[index++];
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
          },
        }),
      );
    }
    return Response.json(this.metadata(object));
  };

  private metadata(object: {
    chunks: Uint8Array[];
    generation: string;
    key: string;
    metadata: Record<string, string>;
  }) {
    return {
      generation: object.generation,
      metadata: object.metadata,
      name: object.key,
      size: String(object.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
    };
  }
}

function fixture(model = new GcsModel()) {
  const options = {
    allowedSessionHosts: ["storage.googleapis.test"],
    auth: { getAccessToken: async () => "token" },
    bucket: "bucket",
    fetch: model.fetch,
  };
  return {
    model,
    restart: () => createGcsHostedByteStore(options),
    store: createGcsHostedByteStore(options),
  };
}

describe("GcsHostedByteStore", () => {
  hostedByteStoreContract(async () => fixture());

  it("reports provider status without response or session secrets", async () => {
    const { model, store } = fixture();
    model.initiationStatus = 403;
    const begun = await store.begin(
      task,
      "private/path",
      { size: 0, sha256: generatedDigest(0) },
      context(),
    );
    expect(begun.isErr() && begun.error.message).toContain("403");
    expect(begun.isErr() && begun.error.message).not.toContain("secret");
    expect(begun.isErr() && begun.error.message).not.toContain("private/path");
  });

  it("does not send the final bytes until EOF and the declared hash are verified", async () => {
    const { model, store } = fixture();
    const size = 300_000;
    const expected = {
      size,
      sha256: createHash("sha256").update(new Uint8Array(size)).digest("hex"),
    };
    const begun = await store.begin(task, "wrong-hash", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const result = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(size),
      expected,
      context(),
    );
    expect(result.isErr()).toBe(true);
    expect(model.objects.size).toBe(0);
    const queried = await store.query(task, begun.value.sessionId, context());
    expect(queried.isOk() && queried.value.type === "cancelled").toBe(true);
    expect(model.largestRequest).toBeLessThanOrEqual(256 * 1024);
  });

  it("rejects a resumable response that did not acknowledge the full chunk", async () => {
    const { model, store } = fixture();
    const expected = { size: 300_000, sha256: generatedDigest(300_000) };
    const begun = await store.begin(task, "short-ack", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    model.shortAcknowledge = true;
    expect(
      (
        await store.write(
          task,
          begun.value.sessionId,
          generatedSource(expected.size),
          expected,
          context(),
        )
      ).isErr(),
    ).toBe(true);
    expect(model.objects.size).toBe(0);
  });

  it.each([0, 256 * 1024])("commits a %i-byte object", async (size) => {
    const { store } = fixture();
    const expected = { size, sha256: generatedDigest(size) };
    const begun = await store.begin(task, `boundary-${size}`, expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const written = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(size),
      expected,
      context(),
    );
    expect(written.isOk() && written.value.size === size).toBe(true);
  });

  it("recovers a committed generation after the final response is lost", async () => {
    const { model, restart, store } = fixture();
    const expected = { size: 300_000, sha256: generatedDigest(300_000) };
    const begun = await store.begin(task, "lost-response", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    model.loseFinalResponse = true;
    const written = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(expected.size),
      expected,
      context(),
    );
    expect(written.isErr()).toBe(true);
    const recovered = await restart().query(task, begun.value.sessionId, context());
    expect(recovered.isOk() && recovered.value.type === "committed").toBe(true);
  });

  it("cancels provider bytes when the source fails instead of producing EOF", async () => {
    const { model, store } = fixture();
    const expected = { size: 300_000, sha256: generatedDigest(300_000) };
    const begun = await store.begin(task, "source-error", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const written = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(expected.size, expected.size),
      expected,
      context(),
    );
    expect(written.isErr()).toBe(true);
    expect(model.objects.size).toBe(0);
    const queried = await store.query(task, begun.value.sessionId, context());
    expect(queried.isOk() && queried.value.type === "cancelled").toBe(true);
  });

  it("reports committed when cancellation races a completed final request", async () => {
    const { model, store } = fixture();
    const expected = { size: 300_000, sha256: generatedDigest(300_000) };
    const begun = await store.begin(task, "cancel-race", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    let release: (() => void) | undefined;
    model.finalResponseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let committed: (() => void) | undefined;
    const providerCommitted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    model.finalCommitted = committed;
    const writing = store.write(
      task,
      begun.value.sessionId,
      generatedSource(expected.size),
      expected,
      context(),
    );
    await providerCommitted;
    const cancelled = await store.cancel(task, begun.value.sessionId, context());
    expect(cancelled.isOk() && cancelled.value.type === "committed").toBe(true);
    release?.();
    expect((await writing).isOk()).toBe(true);
  });

  it("reports a truncated exact-generation read at EOF", async () => {
    const { model, store } = fixture();
    const expected = { size: 300_000, sha256: generatedDigest(300_000) };
    const begun = await store.begin(task, "truncated-read", expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const written = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(expected.size),
      expected,
      context(),
    );
    expect(written.isOk()).toBe(true);
    if (written.isErr()) return;
    model.truncateReads = true;
    const opened = await store.openExact(task, written.value.ref, context());
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    let finalWasError = false;
    for (;;) {
      const next = await opened.value.source.next(task, context());
      if (next.isErr()) {
        finalWasError = true;
        break;
      }
      if (next.value === null) break;
    }
    expect(finalWasError).toBe(true);
    expect((await opened.value.source.close(task)).isOk()).toBe(true);
  });
});

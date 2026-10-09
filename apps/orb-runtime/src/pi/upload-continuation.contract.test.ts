import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, ServerFrame } from "@pi-orb/protocol";
import { okAsync, Result } from "neverthrow";
import { expect, it } from "vitest";
import { UploadContinuationPhases } from "../../../../e2e/testkit/upload-continuation-phases.ts";
import { PiOrbAgent } from "./agent.ts";

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function activity(agent: PiOrbAgent) {
  const health = agent.getHealth();
  if (health.status !== "ready") throw new Error("composed agent not ready");
  return health.activity;
}
function event(response: ServerResponse, type: string, data: Record<string, unknown>) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
function complete(response: ServerResponse) {
  event(response, "response.completed", {
    response: {
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  response.end();
}

for (const mode of [
  "success",
  "socket-error",
  "sse-eof",
  "retry-success",
  "abort-error",
] as const) {
  it(`installed SDK/native bash → public history/retirement: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-upload-contract-"));
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 13, 0xa7);
    const hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(dir, "e2e-upload.bin"), bytes);
    writeFileSync(join(dir, "e2e-sidecar.txt"), "UPLOAD_SIDECAR\n");
    const nextRequest = latch<{
      response: ServerResponse;
      hashPresent: boolean;
      sidecarPresent: boolean;
      decodeOk: boolean;
    }>();
    const recoveryRequest = latch<ServerResponse>();
    const shellResult = latch<void>();
    const finalHistory = latch<void>();
    const retired = latch<RuntimeEvent>();
    const phases = new UploadContinuationPhases();
    const frames: ServerFrame[] = [];
    let requests = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const decoded = Result.fromThrowable(
          () => {
            const bytes = Buffer.concat(chunks);
            return (
              request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes
            ).toString("utf8");
          },
          () => ({ type: "request_decode_failed" as const }),
        )();
        const body = decoded.isOk() ? decoded.value : "";
        requests++;
        if (requests === 2) {
          nextRequest.resolve({
            response,
            hashPresent: body.includes(hash),
            sidecarPresent: body.includes("UPLOAD_SIDECAR"),
            decodeOk: decoded.isOk(),
          });
          return;
        }
        if (requests === 3) {
          recoveryRequest.resolve(response);
          return;
        }
        if (requests !== 1) {
          response.writeHead(500);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const item = {
          type: "function_call",
          id: "fc_upload",
          call_id: "call_upload",
          name: "bash",
          arguments: JSON.stringify({ command: "sha256sum e2e-upload.bin && cat e2e-sidecar.txt" }),
        };
        event(response, "response.output_item.added", {
          output_index: 0,
          item: { ...item, arguments: "" },
        });
        event(response, "response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        });
        event(response, "response.output_item.done", { output_index: 0, item });
        complete(response);
      });
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing owned port");
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        allowModelNetwork: false,
      });
      const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "contract" } })).toString("base64url")}.test`;
      runtime.registerProvider("openai-codex", {
        api: "openai-codex-responses",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: token,
        models: [
          {
            id: "upload-contract",
            name: "Upload contract",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      const model = runtime.getModel("openai-codex", "upload-contract");
      if (!model) throw new Error("missing installed SDK model");
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: join(dir, "agent"),
        extensionFactories: [phases.extension()],
        systemPromptOverride: () => "Use bash to verify the files, then reply.",
      });
      await loader.reload();
      const manager = SessionManager.create(dir, join(dir, "sessions"));
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: join(dir, "agent"),
        modelRuntime: runtime,
        model,
        sessionManager: manager,
        resourceLoader: loader,
        tools: ["bash"],
        settingsManager: SettingsManager.inMemory({
          transport: "sse",
          cacheWarming: "off",
          compaction: { enabled: false },
          retry: {
            enabled: mode === "retry-success",
            maxRetries: 1,
            baseDelayMs: 1,
            provider: { maxRetries: 0 },
          },
        }),
      }));
      const agent = new PiOrbAgent({
        orbId: "upload-contract",
        repositoryUrl: "https://example.com/repo",
        workDir: dir,
        skillsDir: null,
        broker: null,
      });
      agent.subscribe((frame) => {
        frames.push(frame);
        if (frame.type === "runtime.event") {
          if (frame.event.type === "operation_started") phases.operation(frame.event.operationId);
          if (frame.event.type === "operation_finished") {
            phases.record("operationretired");
            retired.resolve(frame.event);
          }
        }
        if (frame.type === "history.record" && frame.record.type === "message") {
          if (frame.record.role === "tool") shellResult.resolve();
          if (
            frame.record.role === "assistant" &&
            (frame.record.finishReason === "stop" || frame.record.finishReason === "error")
          )
            finalHistory.resolve();
        }
      });
      agent.attachSession(session, manager, { summarize: () => okAsync("") });
      if (mode === "abort-error") {
        session.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "error"
          )
            void agent.abortOperation();
        });
      }
      const delivery = agent.deliverInboxMessage(
        "upload-inbox",
        ["upload-inbox"],
        [{ type: "text", text: "The user uploaded files: e2e-upload.bin and e2e-sidecar.txt" }],
      );
      const next = await nextRequest.promise;
      let response = next.response;
      const { hashPresent, sidecarPresent, decodeOk } = next;
      expect(decodeOk).toBe(true);
      expect(hashPresent).toBe(true);
      expect(sidecarPresent).toBe(true);
      // HTTP admission causally follows committed native shell output.
      const results = manager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
      expect(results).toHaveLength(1);
      const serialized = JSON.stringify(results);
      expect(serialized).toContain(hash);
      expect(serialized).toContain("UPLOAD_SIDECAR");
      expect(serialized).toContain('"isError":false');
      await shellResult.promise;
      expect(activity(agent)).toBe("busy");
      expect(
        frames.some(
          (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
        ),
      ).toBe(false);
      if (mode === "retry-success") {
        const retryStarted = latch<void>();
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "auto_retry_start") retryStarted.resolve();
        });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Service unavailable" } }));
        await retryStarted.promise;
        unsubscribe();
        response = await recoveryRequest.promise;
        expect(activity(agent)).toBe("busy");
        expect(
          frames.some(
            (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
          ),
        ).toBe(false);
        expect(
          frames.some(
            (frame) =>
              frame.type === "history.record" &&
              frame.record.type === "message" &&
              frame.record.finishReason === "error",
          ),
        ).toBe(true);
      }
      if (mode === "socket-error") response.destroy();
      else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        event(response, "response.created", {
          response: { id: "resp_final", status: "in_progress", output: [] },
        });
        if (mode === "sse-eof" || mode === "abort-error") response.end();
        else {
          const item = {
            type: "message",
            id: "msg_final",
            role: "assistant",
            status: "in_progress",
            content: [],
          };
          event(response, "response.output_item.added", { output_index: 0, item });
          event(response, "response.content_part.added", {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          event(response, "response.output_text.delta", {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "UPLOAD_VERIFIED",
          });
          // Stream stays open: headers/tokens cannot retire this operation.
          const streamSeen = latch<void>();
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_update") streamSeen.resolve();
          });
          await streamSeen.promise;
          unsubscribe();
          expect(activity(agent)).toBe("busy");
          expect(
            frames.some(
              (frame) =>
                frame.type === "runtime.event" && frame.event.type === "operation_finished",
            ),
          ).toBe(false);
          event(response, "response.output_item.done", {
            output_index: 0,
            item: {
              ...item,
              status: "completed",
              content: [{ type: "output_text", text: "UPLOAD_VERIFIED", annotations: [] }],
            },
          });
          complete(response);
        }
      }
      const outcome = await retired.promise;
      await finalHistory.promise;
      expect((await delivery).isOk()).toBe(true);
      expect(activity(agent)).toBe("idle");
      expect(outcome.type).toBe("operation_finished");
      const file = manager.getSessionFile();
      expect(file).toBeTypeOf("string");
      if (file === undefined) throw new Error("missing persisted session file");
      const disk = readFileSync(file, "utf8");
      const succeeded = mode === "success" || mode === "retry-success";
      if (succeeded) expect(disk).toContain("UPLOAD_VERIFIED");
      else {
        expect(disk).toContain('"stopReason":"error"');
        expect(disk).not.toContain("UPLOAD_VERIFIED");
        expect(
          frames.some(
            (frame) =>
              frame.type === "history.record" &&
              frame.record.type === "message" &&
              frame.record.finishReason === "error" &&
              Boolean(frame.record.failure?.message),
          ),
        ).toBe(true);
      }
      const finalIndex = frames.findIndex(
        (frame) =>
          frame.type === "history.record" &&
          frame.record.type === "message" &&
          frame.record.finishReason === (succeeded ? "stop" : "error"),
      );
      const retiredIndex = frames.findIndex(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      );
      expect(finalIndex).toBeGreaterThan(-1);
      expect(retiredIndex).toBeGreaterThan(finalIndex);
      const duplicate = await agent.deliverInboxMessage(
        "upload-inbox",
        ["upload-inbox"],
        [{ type: "text", text: "The user uploaded files:" }],
      );
      expect(duplicate.isOk() && duplicate.value.duplicate).toBe(true);
      expect(requests).toBe(mode === "retry-success" ? 3 : 2);
      const tail = phases.tail();
      expect(tail.at(-1)?.stage).toBe("operationretired");
      expect(tail.some((row) => row.stage === "toolresult")).toBe(true);
      expect(tail.filter((row) => row.stage === "request")).toHaveLength(
        mode === "retry-success" ? 3 : 2,
      );
      expect(tail.every((row) => row.operationId === tail[0]?.operationId)).toBe(true);
      expect(tail.filter((row) => row.stage === "providerprepare")).toHaveLength(
        mode === "retry-success" ? 3 : 2,
      );
      expect(tail.filter((row) => row.stage === "headers")).toHaveLength(
        mode === "retry-success" ? 3 : mode === "socket-error" ? 1 : 2,
      );
      expect(tail.filter((row) => row.stage === "firstevent")).toHaveLength(
        mode === "socket-error" ? 1 : 2,
      );
      expect(tail.some((row) => row.stage === "error")).toBe(mode !== "success");
      expect(tail.find((row) => row.stage === "toolresult")?.callId).toBe("call_upload|fc_upload");
      console.log(JSON.stringify({ mode, phases: tail }));
      if (outcome.type === "operation_finished") {
        expect(outcome.outcome).toBe(
          mode === "abort-error" ? "aborted" : succeeded ? "completed" : "failed",
        );
        if (!succeeded && mode !== "abort-error") {
          const terminal = frames.findLast(
            (frame) =>
              frame.type === "history.record" &&
              frame.record.type === "message" &&
              frame.record.role === "assistant",
          );
          if (terminal?.type === "history.record" && terminal.record.type === "message")
            expect(outcome.message).toBe(terminal.record.failure?.message);
        }
      }
      if (!succeeded) {
        const nextRetired = latch<RuntimeEvent>();
        const unsubscribe = agent.subscribe((frame) => {
          if (frame.type === "runtime.event" && frame.event.type === "operation_finished")
            nextRetired.resolve(frame.event);
        });
        const nextDelivery = agent.deliverInboxMessage(
          "next-inbox",
          ["next-inbox"],
          [{ type: "text", text: "Continue successfully." }],
        );
        const nextResponse = await recoveryRequest.promise;
        expect(activity(agent)).toBe("busy");
        nextResponse.writeHead(200, { "content-type": "text/event-stream" });
        complete(nextResponse);
        const nextOutcome = await nextRetired.promise;
        expect((await nextDelivery).isOk()).toBe(true);
        expect(nextOutcome).toMatchObject({ type: "operation_finished", outcome: "completed" });
        expect(activity(agent)).toBe("idle");
        unsubscribe();
      }
    } finally {
      if (session) {
        await session.abort();
        session.dispose();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

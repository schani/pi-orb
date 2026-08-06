import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  CAPABILITY_ABORT,
  type ClientAction,
  ClientFrameSchema,
  type HistoryRecord,
  type OrbHistoryView,
  type OrbView,
  type ProjectView,
  RUNTIME_SUBPROTOCOL,
  type ServerFrame,
} from "@pi-orb/protocol";
import { Check } from "typebox/value";
import type { Plugin } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const PROJECT_ID = "frontend-fixture-project";
const ORB_ID = "frontend-fixture-orb";
const NEW_ORB_STARTUP_DELAY_MS = 10_000;
const now = () => new Date().toISOString();

interface MockState {
  projects: Map<string, ProjectView>;
  orbs: Map<string, OrbView>;
  histories: Map<string, HistoryRecord[]>;
  startupTimers: Map<string, NodeJS.Timeout>;
}

function initialState(): MockState {
  const createdAt = now();
  const project: ProjectView = {
    id: PROJECT_ID,
    name: "Frontend playground",
    repositoryUrl: "https://github.com/example/frontend-playground",
    createdAt,
  };
  const orb: OrbView = {
    id: ORB_ID,
    projectId: PROJECT_ID,
    state: "running",
    stateVersion: 1,
    checkoutCommit: "fixture123",
    previewHost: "frontend-fixture.tailnet.ts.net",
    stateChangedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  const welcomeId = randomUUID();
  const records: HistoryRecord[] = [
    {
      id: welcomeId,
      parentId: null,
      timestamp: createdAt,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "# Frontend playground\n\nThis conversation is supplied by the in-process fixture backend. Send a message and I will echo it with simulated streaming.",
        },
      ],
      overflow: {},
    },
  ];
  return {
    projects: new Map([[project.id, project]]),
    orbs: new Map([[orb.id, orb]]),
    histories: new Map([[orb.id, records]]),
    startupTimers: new Map(),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, {
    error: { code: "not_found", message: "fixture resource not found", retryable: false },
  });
}

async function readJson(request: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function updateOrb(orb: OrbView, state: OrbView["state"]): OrbView {
  const changedAt = now();
  return {
    ...orb,
    state,
    stateVersion: orb.stateVersion + 1,
    stateChangedAt: changedAt,
    updatedAt: changedAt,
  };
}

async function handleApi(
  state: MockState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && path === "/api/v1/projects") {
    sendJson(response, 200, { items: [...state.projects.values()] });
    return true;
  }
  if (method === "POST" && path === "/api/v1/projects") {
    const body = await readJson(request);
    if (
      body === null ||
      typeof body !== "object" ||
      !("id" in body) ||
      !("name" in body) ||
      !("repositoryUrl" in body) ||
      typeof body.id !== "string" ||
      typeof body.name !== "string" ||
      typeof body.repositoryUrl !== "string"
    ) {
      sendJson(response, 400, {
        error: { code: "invalid_request", message: "invalid project", retryable: false },
      });
      return true;
    }
    const project: ProjectView = {
      id: body.id,
      name: body.name,
      repositoryUrl: body.repositoryUrl,
      createdAt: now(),
    };
    state.projects.set(project.id, project);
    sendJson(response, 201, project);
    return true;
  }

  const projectOrbs = /^\/api\/v1\/projects\/([^/]+)\/orbs$/.exec(path);
  if (projectOrbs !== null) {
    const projectId = decodeURIComponent(projectOrbs[1] ?? "");
    if (!state.projects.has(projectId)) {
      notFound(response);
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, {
        items: [...state.orbs.values()].filter((orb) => orb.projectId === projectId),
      });
      return true;
    }
    if (method === "POST") {
      const body = await readJson(request);
      if (
        body === null ||
        typeof body !== "object" ||
        !("id" in body) ||
        typeof body.id !== "string"
      ) {
        sendJson(response, 400, {
          error: { code: "invalid_request", message: "invalid orb", retryable: false },
        });
        return true;
      }
      const createdAt = now();
      const orb: OrbView = {
        id: body.id,
        projectId,
        state: "creating",
        stateVersion: 1,
        stateChangedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      };
      state.orbs.set(orb.id, orb);
      state.histories.set(orb.id, []);
      const timer = setTimeout(() => {
        state.startupTimers.delete(orb.id);
        const current = state.orbs.get(orb.id);
        if (current?.state === "creating") {
          state.orbs.set(orb.id, updateOrb(current, "running"));
        }
      }, NEW_ORB_STARTUP_DELAY_MS);
      state.startupTimers.set(orb.id, timer);
      sendJson(response, 202, orb);
      return true;
    }
  }

  const orbRoute = /^\/api\/v1\/orbs\/([^/]+)(?:\/(history|start|stop))?$/.exec(path);
  if (orbRoute !== null) {
    const orbId = decodeURIComponent(orbRoute[1] ?? "");
    const action = orbRoute[2];
    const orb = state.orbs.get(orbId);
    if (orb === undefined) {
      notFound(response);
      return true;
    }
    if (method === "GET" && action === undefined) {
      sendJson(response, 200, orb);
      return true;
    }
    if (method === "GET" && action === "history") {
      const records = state.histories.get(orbId) ?? [];
      const headId = records.at(-1)?.id ?? null;
      const view: OrbHistoryView = {
        orbId,
        session: { id: `fixture-session-${orbId}`, overflow: {} },
        cursor: headId,
        headId,
        records,
      };
      sendJson(response, 200, view);
      return true;
    }
    if (method === "POST" && (action === "start" || action === "stop")) {
      const updated = updateOrb(orb, action === "start" ? "running" : "stopped");
      state.orbs.set(orbId, updated);
      sendJson(response, 202, updated);
      return true;
    }
  }

  if (path.startsWith("/api/")) {
    notFound(response);
    return true;
  }
  return false;
}

interface LiveSession {
  socket: WebSocket;
  orbId: string;
  operation: { id: string; timer: NodeJS.Timeout } | null;
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function eventFrame(event: ServerFrame & { type: "runtime.event" }): ServerFrame {
  return event;
}

function appendRecord(state: MockState, orbId: string, record: HistoryRecord): void {
  const records = state.histories.get(orbId) ?? [];
  records.push(record);
  state.histories.set(orbId, records);
}

function completeEcho(
  state: MockState,
  session: LiveSession,
  operationId: string,
  text: string,
): void {
  if (session.operation?.id !== operationId) return;
  const records = state.histories.get(session.orbId) ?? [];
  const record: HistoryRecord = {
    id: randomUUID(),
    parentId: records.at(-1)?.id ?? null,
    timestamp: now(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "fixture", id: "echo" },
    finishReason: "stop",
    overflow: {},
  };
  appendRecord(state, session.orbId, record);
  send(session.socket, {
    v: 1,
    type: "history.record",
    at: now(),
    record,
    headId: record.id,
  });
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: { type: "operation_finished", operationId, outcome: "completed" },
    }),
  );
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: { type: "status", activity: "idle" },
    }),
  );
  session.operation = null;
}

function completeShell(
  state: MockState,
  session: LiveSession,
  operationId: string,
  command: string,
  output: string,
  excludeFromContext: boolean,
): void {
  if (session.operation?.id !== operationId) return;
  const records = state.histories.get(session.orbId) ?? [];
  const recordId = randomUUID();
  const timestamp = now();
  const parentId = records.at(-1)?.id ?? null;
  const record: HistoryRecord = {
    id: recordId,
    parentId,
    timestamp,
    type: "event",
    eventType: "pi.bash_execution",
    content: [{ type: "text", text: `${command}\n${output}` }],
    overflow: {
      native: {
        type: "message",
        id: recordId,
        parentId,
        timestamp,
        message: {
          role: "bashExecution",
          command,
          output,
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext,
          timestamp: Date.now(),
        },
      },
    },
  };
  appendRecord(state, session.orbId, record);
  send(session.socket, {
    v: 1,
    type: "history.record",
    at: now(),
    record,
    headId: record.id,
  });
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: { type: "operation_finished", operationId, outcome: "completed" },
    }),
  );
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: { type: "status", activity: "idle" },
    }),
  );
  session.operation = null;
}

function handleAction(
  state: MockState,
  session: LiveSession,
  requestId: string,
  action: ClientAction,
) {
  if (action.type === "abort") {
    if (session.operation === null || session.operation.id !== action.operationId) {
      send(session.socket, {
        v: 1,
        type: "request.result",
        at: now(),
        requestId,
        result: {
          type: "rejected",
          error: { code: "stale_operation", message: "operation is not active", retryable: false },
        },
      });
      return;
    }
    clearTimeout(session.operation.timer);
    session.operation = null;
    send(session.socket, {
      v: 1,
      type: "request.result",
      at: now(),
      requestId,
      result: { type: "accepted", operationId: action.operationId, duplicate: false },
    });
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: { type: "operation_finished", operationId: action.operationId, outcome: "aborted" },
      }),
    );
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: { type: "status", activity: "idle" },
      }),
    );
    return;
  }

  if (session.operation !== null) {
    send(session.socket, {
      v: 1,
      type: "request.result",
      at: now(),
      requestId,
      result: {
        type: "rejected",
        error: { code: "busy", message: "fixture operation is active", retryable: true },
      },
    });
    return;
  }

  const records = state.histories.get(session.orbId) ?? [];
  const headId = records.at(-1)?.id ?? null;
  if (action.expectedHeadId !== headId) {
    send(session.socket, {
      v: 1,
      type: "request.result",
      at: now(),
      requestId,
      result: {
        type: "rejected",
        error: { code: "stale_head", message: "fixture history changed", retryable: true },
      },
    });
    return;
  }
  const operationId = randomUUID();
  if (action.type === "shell") {
    const output = `fixture output for: ${action.command}`;
    send(session.socket, {
      v: 1,
      type: "request.result",
      at: now(),
      requestId,
      result: { type: "accepted", operationId, duplicate: false },
    });
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: { type: "operation_started", operationId },
      }),
    );
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: { type: "status", activity: "busy", operationId },
      }),
    );
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: {
          type: "output_patch",
          operationId,
          blockId: `${operationId}-shell`,
          blockType: "shell",
          revision: 1,
          patch: { type: "replace", text: `$ ${action.command}` },
        },
      }),
    );
    const timer = setTimeout(() => {
      if (session.operation?.id !== operationId) return;
      send(
        session.socket,
        eventFrame({
          v: 1,
          type: "runtime.event",
          at: now(),
          event: {
            type: "output_patch",
            operationId,
            blockId: `${operationId}-shell`,
            blockType: "shell",
            revision: 2,
            patch: { type: "append", text: `\n${output}` },
          },
        }),
      );
      session.operation.timer = setTimeout(
        () =>
          completeShell(
            state,
            session,
            operationId,
            action.command,
            output,
            action.excludeFromContext,
          ),
        350,
      );
    }, 350);
    session.operation = { id: operationId, timer };
    return;
  }

  const inputText = action.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const userRecord: HistoryRecord = {
    id: randomUUID(),
    parentId: headId,
    timestamp: now(),
    type: "message",
    role: "user",
    content: action.content,
    overflow: {},
  };
  appendRecord(state, session.orbId, userRecord);
  send(session.socket, {
    v: 1,
    type: "request.result",
    at: now(),
    requestId,
    result: { type: "accepted", operationId, duplicate: false },
  });
  send(session.socket, {
    v: 1,
    type: "history.record",
    at: now(),
    record: userRecord,
    headId: userRecord.id,
  });
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: { type: "operation_started", operationId },
    }),
  );
  const echoedInput = `> ${inputText || "(image attachment)"}`;
  const echo = `You said:\n\n${echoedInput}\n\n_Echoed by the frontend fixture._`;
  send(
    session.socket,
    eventFrame({
      v: 1,
      type: "runtime.event",
      at: now(),
      event: {
        type: "output_patch",
        operationId,
        blockId: `${operationId}-text`,
        blockType: "text",
        revision: 1,
        patch: { type: "replace", text: "You said:\n\n" },
      },
    }),
  );
  const timer = setTimeout(() => {
    if (session.operation?.id !== operationId) return;
    send(
      session.socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: {
          type: "output_patch",
          operationId,
          blockId: `${operationId}-text`,
          blockType: "text",
          revision: 2,
          patch: { type: "append", text: `${echoedInput}\n\n_Echoed by the frontend fixture._` },
        },
      }),
    );
    session.operation.timer = setTimeout(
      () => completeEcho(state, session, operationId, echo),
      350,
    );
  }, 350);
  session.operation = { id: operationId, timer };
}

function acceptLiveSocket(state: MockState, socket: WebSocket, orbId: string): void {
  const session: LiveSession = { socket, orbId, operation: null };
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!Check(ClientFrameSchema, parsed)) return;
    if (parsed.type === "client.presence") return;
    if (parsed.type === "client.request") {
      handleAction(state, session, parsed.requestId, parsed.action);
      return;
    }
    const records = state.histories.get(orbId) ?? [];
    const afterIndex =
      parsed.afterRecordId === null
        ? -1
        : records.findIndex((record) => record.id === parsed.afterRecordId);
    const mode = parsed.afterRecordId === null || afterIndex >= 0 ? "after" : "full";
    const replay = mode === "full" ? records : records.slice(afterIndex + 1);
    send(socket, {
      v: 1,
      type: "server.welcome",
      at: now(),
      connectionId: randomUUID(),
      runtimeInstanceId: "frontend-fixture-runtime",
      orbId,
      sessionId: `fixture-session-${orbId}`,
      capabilities: [CAPABILITY_ABORT],
      limits: { maxIncomingFrameBytes: 8 * 1024 * 1024, maxPromptBytes: 6 * 1024 * 1024 },
    });
    send(socket, {
      v: 1,
      type: "sync.started",
      at: now(),
      mode,
      afterRecordId: parsed.afterRecordId,
    });
    for (const record of replay) {
      send(socket, {
        v: 1,
        type: "history.record",
        at: now(),
        record,
        headId: record.id,
      });
    }
    const headId = records.at(-1)?.id ?? null;
    send(socket, { v: 1, type: "sync.completed", at: now(), headId });
    send(
      socket,
      eventFrame({
        v: 1,
        type: "runtime.event",
        at: now(),
        event: { type: "status", activity: "idle" },
      }),
    );
  });
  socket.on("close", () => {
    if (session.operation !== null) clearTimeout(session.operation.timer);
  });
}

/**
 * In-process control-plane/runtime fixture for frontend-only development.
 * It implements the real HTTP and WebSocket contracts, so production UI code
 * has no mock branches and protocol drift remains visible.
 */
export function mockBackendPlugin(): Plugin {
  const state = initialState();
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(RUNTIME_SUBPROTOCOL) ? RUNTIME_SUBPROTOCOL : false,
  });

  return {
    name: "pi-orb-frontend-fixture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleApi(state, request, response).then(
          (handled) => {
            if (!handled) next();
          },
          () => {
            sendJson(response, 500, {
              error: {
                code: "internal",
                message: "frontend fixture request failed",
                retryable: false,
              },
            });
          },
        );
      });

      const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
        const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
        const match = /^\/api\/v1\/orbs\/([^/]+)\/live$/.exec(path);
        if (match === null) return;
        const orbId = decodeURIComponent(match[1] ?? "");
        const orb = state.orbs.get(orbId);
        if (orb?.state !== "running") {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (webSocket) => {
          acceptLiveSocket(state, webSocket, orbId);
        });
      };
      server.httpServer?.prependListener("upgrade", onUpgrade);
      server.httpServer?.once("close", () => {
        server.httpServer?.removeListener("upgrade", onUpgrade);
        for (const timer of state.startupTimers.values()) clearTimeout(timer);
        state.startupTimers.clear();
        sockets.close();
      });
    },
  };
}

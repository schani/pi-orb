import websocketPlugin from "@fastify/websocket";
import {
  ClientPresenceSchema,
  RUNTIME_SUBPROTOCOL,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_SUBPROTOCOL,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Check } from "typebox/value";
import { WebSocket } from "ws";
import { withDeadline } from "../domain/dst.ts";
import { agentPlacement } from "../domain/harness-agent-plane.ts";
import { logOrbEvent } from "../domain/log.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { RolloutSocketRetirement, type SocketRetirementCause } from "../domain/rollout-sockets.ts";
import { attachCentralLive } from "./central-live.ts";
import { type SessionExpiryScheduler, watchSessionExpiry } from "./session-expiry.ts";
import { monitorWebSocketLiveness } from "./websocket-heartbeat.ts";

const TRY_AGAIN_LATER = 1013;
const UNSUPPORTED_DATA = 1003;
const TERMINAL_PROXY_BUFFER_BYTES = 1024 * 1024;

let connectionCounter = 0;

/** Graceful rollout close is bounded even when the peer never acknowledges. */
export function closeRolloutSocket(
  socket: WebSocket,
  forced: () => void,
  schedule: SessionExpiryScheduler = (delay, callback) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
): void {
  if (socket.readyState === WebSocket.CLOSED) return;
  const terminate = (): void => {
    forced();
    try {
      socket.terminate();
    } catch {
      /* already closed */
    }
  };
  if (socket.readyState === WebSocket.CONNECTING) {
    terminate();
    return;
  }
  let stopped = false;
  let cancel = (): void => undefined;
  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    cancel();
    socket.off("close", cleanup);
  };
  socket.once("close", cleanup);
  cancel = schedule(1_000, () => {
    cleanup();
    if (socket.readyState !== WebSocket.CLOSED) terminate();
  });
  try {
    socket.close(1012, "deployment rollover");
  } catch {
    cleanup();
    terminate();
  }
}

/**
 * Live routing (docs/runtime-protocol.md/docs/history-replication.md): host-native
 * text frames and close signals are forwarded to/from the runtime without
 * application interpretation, except for the idle-auto-stop sniffs below.
 * The browser's `client.hello` is the first application frame. A connection race
 * or unavailable runtime closes with 1013, and the browser reconnects.
 * Central placement uses central-live.ts instead: it validates client frames,
 * handles the hello/synchronization handshake locally, and dispatches requests
 * through the agent session facade without a guest socket.
 *
 * Idle auto-stop (docs/lifecycle.md) consumes presence frames here and refreshes
 * the advisory `last_busy_at` timestamp on client requests. Host-native requests
 * are then forwarded unchanged.
 */
export async function registerLiveProxy(
  app: FastifyInstance,
  task: SimulationTask,
  deps: ControlPlaneDeps,
  scheduleSessionExpiry?: SessionExpiryScheduler,
  rollout: RolloutSocketRetirement = new RolloutSocketRetirement(),
): Promise<void> {
  const rejectRetired = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (rollout.retirement !== null) {
      reply
        .header("cache-control", "no-store")
        .header("retry-after", "1")
        .status(503)
        .send({
          error: { code: "unavailable", message: "Deployment in progress", retryable: true },
        });
    }
  };
  await app.register(websocketPlugin, {
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(RUNTIME_SUBPROTOCOL)
          ? RUNTIME_SUBPROTOCOL
          : protocols.has(TERMINAL_SUBPROTOCOL)
            ? TERMINAL_SUBPROTOCOL
            : false,
    },
  });

  app.get<{ Params: { orbId: string } }>(
    "/api/v1/orbs/:orbId/live",
    { websocket: true, preValidation: rejectRetired },
    async (browserSocket, request) => {
      const orbId = request.params.orbId;
      connectionCounter += 1;
      const connectionId = `browser-${connectionCounter}`;
      let upstream: WebSocket | null = null;
      let upstreamOpen = false;
      let browserClosed = false;
      let centralAttached = false;
      let detachCentral = (): void => undefined;
      const pendingToUpstream: string[] = [];
      const closeBoth = (code: number, reason: string): void => {
        try {
          browserSocket.close(code, reason);
        } catch {
          // Socket already closing; nothing to do.
        }
        try {
          upstream?.close(code, reason);
        } catch {
          // Socket already closing; nothing to do.
        }
      };
      const session = watchSessionExpiry(
        request.authExpiresAt,
        () => task.wallNow(),
        () => {
          browserClosed = true;
          closeBoth(1008, "session expired");
        },
        scheduleSessionExpiry,
      );
      browserSocket.once("close", session.stop);
      browserSocket.once("error", session.stop);
      if (!session.admit()) return;
      deps.control.registerBrowserConnection(orbId, connectionId, () =>
        closeBoth(TRY_AGAIN_LATER, "orb is being deleted"),
      );
      monitorWebSocketLiveness(browserSocket, {
        onTimeout: () =>
          request.log.warn({ orbId, connectionId, leg: "browser" }, "live websocket timed out"),
      });

      // Attach handlers synchronously: the browser sends client.hello as soon
      // as its upgrade completes, while routing below crosses async adapter
      // boundaries. Queue frames until the runtime socket is open.
      browserSocket.on("message", (data: Buffer, isBinary: boolean) => {
        if (browserClosed || !session.admit()) return;
        if (isBinary) {
          closeBoth(UNSUPPORTED_DATA, "binary frames are not accepted");
          return;
        }
        const text = data.toString();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON: forwarded as-is; the runtime answers invalid_frame.
        }
        if (Check(ClientPresenceSchema, parsed)) {
          deps.control.setBrowserVisibility(orbId, connectionId, parsed.visible, task.wallNow());
          return;
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { type?: unknown }).type === "client.request"
        ) {
          // Fire-and-forget: the timestamp is advisory (docs/lifecycle.md).
          void deps.store.touchLastBusy(task, { orbId, now: task.wallNow() });
        }
        if (centralAttached) return;
        if (upstreamOpen && upstream !== null) {
          upstream.send(text);
        } else {
          pendingToUpstream.push(text);
        }
      });
      browserSocket.on("close", () => {
        browserClosed = true;
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        try {
          upstream?.close();
        } catch {
          // Already closed.
        }
      });
      browserSocket.on("error", () => {
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        try {
          upstream?.close();
        } catch {
          // Already closed.
        }
      });

      const retireConnection = (cause: SocketRetirementCause): void => {
        browserClosed = true;
        session.stop();
        pendingToUpstream.length = 0;
        detachCentral();
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        const force = (leg: string) => () =>
          logOrbEvent(task, orbId, "rollout-socket-forced", {
            ...cause,
            connectionId,
            leg,
            socketCount: 1,
            cause: "close_deadline_or_connecting",
          });
        closeRolloutSocket(browserSocket, force("browser"));
        if (upstream !== null) closeRolloutSocket(upstream, force("runtime"));
      };
      const unregisterRollout = rollout.register(retireConnection);
      if (unregisterRollout === null) {
        if (rollout.retirement !== null) retireConnection(rollout.retirement);
        return;
      }
      const untrack = (): void => {
        unregisterRollout();
        browserSocket.off("close", untrack);
        browserSocket.off("error", untrack);
      };
      browserSocket.once("close", untrack);
      browserSocket.once("error", untrack);

      const orbResult = await deps.store.getOrb(task, orbId);
      if (browserClosed) return;
      const agentPlane = deps.agentPlane;
      if (
        agentPlane &&
        orbResult.isOk() &&
        orbResult.value !== null &&
        agentPlacement(agentPlane, orbResult.value) === "central"
      ) {
        const orb = orbResult.value;
        if (orb.state === "deleting") {
          closeBoth(TRY_AGAIN_LATER, "orb is being deleted");
          return;
        }
        const readSession = agentPlane.readSession?.bind(agentPlane);
        if (readSession === undefined) {
          closeBoth(TRY_AGAIN_LATER, "central conversation unavailable");
          return;
        }
        const opened = await withDeadline(
          task,
          deps.constants.providerOperationTimeoutMs,
          "read central conversation",
          (context) => readSession(task, orb, context),
        );
        if (opened.isErr()) {
          request.log.warn(
            { orbId, connectionId, retryable: opened.error.retryable },
            "central conversation unavailable",
          );
          closeBoth(TRY_AGAIN_LATER, "central agent unavailable");
          return;
        }
        const session = opened.value;
        if (browserClosed) return;
        centralAttached = true;
        detachCentral = attachCentralLive(
          browserSocket,
          session,
          pendingToUpstream,
          (requestId, retryable) =>
            request.log.warn(
              { orbId, connectionId, requestId, retryable },
              "central agent request failed",
            ),
        );
        pendingToUpstream.length = 0;
        return;
      }
      if (
        orbResult.isErr() ||
        orbResult.value === null ||
        orbResult.value.state !== "running" ||
        deps.control.isStopping(orbId, orbResult.value.stateVersion)
      ) {
        closeBoth(TRY_AGAIN_LATER, "orb is not running");
        return;
      }
      const orb = orbResult.value;
      if (orb.hostRef === null) {
        closeBoth(TRY_AGAIN_LATER, "orb has no host");
        return;
      }
      const observed = await withDeadline(
        task,
        deps.constants.providerOperationTimeoutMs,
        "observe host for live proxy",
        (context) =>
          deps.hostProvider.observe(
            task,
            { provider: deps.hostProvider.kind, resourceId: orb.hostRef ?? "" },
            context,
          ),
      );
      if (
        observed.isErr() ||
        observed.value === null ||
        observed.value.state !== "running" ||
        observed.value.runtimeAddress === undefined
      ) {
        closeBoth(TRY_AGAIN_LATER, "runtime unavailable");
        return;
      }
      if (browserClosed || !session.admit()) return;

      const wsUrl = `${observed.value.runtimeAddress.baseUrl.replace(/^http/, "ws")}/v1/live`;
      const runtimeSocket = new WebSocket(wsUrl, [RUNTIME_SUBPROTOCOL]);
      upstream = runtimeSocket;
      monitorWebSocketLiveness(runtimeSocket, {
        onTimeout: () =>
          request.log.warn({ orbId, connectionId, leg: "runtime" }, "live websocket timed out"),
      });

      runtimeSocket.on("open", () => {
        if (browserClosed || !session.admit()) {
          closeBoth(1008, "session expired");
          return;
        }
        upstreamOpen = true;
        for (const message of pendingToUpstream) runtimeSocket.send(message);
        pendingToUpstream.length = 0;
      });
      runtimeSocket.on("message", (data, isBinary) => {
        if (browserClosed || !session.admit()) return;
        if (isBinary) {
          closeBoth(UNSUPPORTED_DATA, "binary frames are not accepted");
          return;
        }
        browserSocket.send(data.toString());
      });
      runtimeSocket.on("close", (code, reason) => {
        try {
          browserSocket.close(
            code >= 1000 && code < 5000 ? code : TRY_AGAIN_LATER,
            reason.toString(),
          );
        } catch {
          // Already closed.
        }
      });
      runtimeSocket.on("error", () => {
        closeBoth(TRY_AGAIN_LATER, "runtime connection failed");
      });
    },
  );

  app.get<{ Params: { orbId: string } }>(
    "/api/v1/orbs/:orbId/terminal",
    { websocket: true, preValidation: rejectRetired },
    async (browserSocket, request) => {
      const orbId = request.params.orbId;
      let upstream: WebSocket | null = null;
      let upstreamOpen = false;
      let browserClosed = false;
      const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
      let pendingBytes = 0;
      connectionCounter += 1;
      const connectionId = `terminal-${connectionCounter}`;
      const closeBoth = (code: number, reason: string): void => {
        try {
          browserSocket.close(code, reason);
        } catch {
          /* already closing */
        }
        try {
          upstream?.close(code, reason);
        } catch {
          /* already closing */
        }
      };
      const session = watchSessionExpiry(
        request.authExpiresAt,
        () => task.wallNow(),
        () => {
          browserClosed = true;
          closeBoth(1008, "session expired");
        },
        scheduleSessionExpiry,
      );
      browserSocket.once("close", session.stop);
      browserSocket.once("error", session.stop);
      if (!session.admit()) return;
      deps.control.registerBrowserConnection(
        orbId,
        connectionId,
        () => closeBoth(TRY_AGAIN_LATER, "orb is stopping"),
        "execution",
      );

      browserSocket.on("message", (data: Buffer, isBinary: boolean) => {
        if (browserClosed || !session.admit()) return;
        const copy = Buffer.from(data);
        if (copy.byteLength > TERMINAL_MAX_INPUT_BYTES) {
          closeBoth(1009, "terminal frame is too large");
          return;
        }
        void deps.store.touchLastBusy(task, { orbId, now: task.wallNow() });
        if (upstreamOpen && upstream !== null) {
          if (upstream.bufferedAmount > TERMINAL_PROXY_BUFFER_BYTES) {
            closeBoth(TRY_AGAIN_LATER, "terminal input consumer is too slow");
            return;
          }
          try {
            upstream.send(copy, { binary: isBinary });
          } catch {
            closeBoth(TRY_AGAIN_LATER, "terminal input forwarding failed");
          }
        } else {
          pendingBytes += copy.byteLength;
          if (pendingBytes > TERMINAL_PROXY_BUFFER_BYTES) {
            closeBoth(TRY_AGAIN_LATER, "terminal routing queue overflow");
            return;
          }
          pending.push({ data: copy, isBinary });
        }
      });
      browserSocket.on("close", () => {
        browserClosed = true;
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        try {
          upstream?.close();
        } catch {
          /* already closed */
        }
      });
      browserSocket.on("error", () => {
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        try {
          upstream?.close();
        } catch {
          /* already closed */
        }
      });

      const retireConnection = (cause: SocketRetirementCause): void => {
        browserClosed = true;
        session.stop();
        pending.length = 0;
        pendingBytes = 0;
        deps.control.unregisterBrowserConnection(orbId, connectionId, task.wallNow());
        const force = (leg: string) => () =>
          logOrbEvent(task, orbId, "rollout-socket-forced", {
            ...cause,
            connectionId,
            leg,
            socketCount: 1,
            cause: "close_deadline_or_connecting",
          });
        closeRolloutSocket(browserSocket, force("browser"));
        if (upstream !== null) closeRolloutSocket(upstream, force("runtime"));
      };
      const unregisterRollout = rollout.register(retireConnection);
      if (unregisterRollout === null) {
        if (rollout.retirement !== null) retireConnection(rollout.retirement);
        return;
      }
      const untrack = (): void => {
        unregisterRollout();
        browserSocket.off("close", untrack);
        browserSocket.off("error", untrack);
      };
      browserSocket.once("close", untrack);
      browserSocket.once("error", untrack);

      const orbResult = await deps.store.getOrb(task, orbId);
      if (browserClosed) return;
      if (
        orbResult.isErr() ||
        orbResult.value === null ||
        orbResult.value.state !== "running" ||
        deps.control.isStopping(orbId, orbResult.value.stateVersion) ||
        orbResult.value.hostRef === null
      ) {
        closeBoth(TRY_AGAIN_LATER, "orb is not running");
        return;
      }
      const observed = await withDeadline(
        task,
        deps.constants.providerOperationTimeoutMs,
        "observe host for terminal proxy",
        (context) =>
          deps.hostProvider.observe(
            task,
            { provider: deps.hostProvider.kind, resourceId: orbResult.value?.hostRef ?? "" },
            context,
          ),
      );
      if (
        observed.isErr() ||
        observed.value === null ||
        observed.value.state !== "running" ||
        observed.value.runtimeAddress === undefined
      ) {
        closeBoth(TRY_AGAIN_LATER, "runtime unavailable");
        return;
      }
      if (browserClosed || !session.admit()) return;

      const executionBinding = deps.hostProvider.executionBinding?.bind(deps.hostProvider);
      const binding = executionBinding
        ? await withDeadline(
            task,
            deps.constants.providerOperationTimeoutMs,
            "bind terminal execution",
            (context) =>
              executionBinding(
                task,
                { provider: deps.hostProvider.kind, resourceId: orbResult.value?.hostRef ?? "" },
                context,
              ),
          )
        : null;
      if (
        binding &&
        (binding.isErr() ||
          binding.value.incarnation !== String(orbResult.value.hostIncarnation) ||
          binding.value.baseUrl !== observed.value.runtimeAddress.baseUrl)
      ) {
        closeBoth(TRY_AGAIN_LATER, "execution binding unavailable");
        return;
      }
      if (browserClosed) return;
      const wsUrl = `${observed.value.runtimeAddress.baseUrl.replace(/^http/, "ws")}/v1/terminal`;
      const runtimeSocket = new WebSocket(
        wsUrl,
        [TERMINAL_SUBPROTOCOL],
        binding?.isOk()
          ? {
              headers: {
                authorization: `Bearer ${binding.value.token}`,
                "x-orb-incarnation": binding.value.incarnation,
              },
            }
          : {},
      );
      upstream = runtimeSocket;
      runtimeSocket.on("open", () => {
        if (browserClosed || !session.admit()) {
          closeBoth(1008, "session expired");
          return;
        }
        upstreamOpen = true;
        try {
          for (const frame of pending) runtimeSocket.send(frame.data, { binary: frame.isBinary });
        } catch {
          closeBoth(TRY_AGAIN_LATER, "terminal input forwarding failed");
        }
        pending.length = 0;
        pendingBytes = 0;
      });
      runtimeSocket.on("message", (data, isBinary) => {
        if (browserClosed || !session.admit()) return;
        if (browserSocket.bufferedAmount > TERMINAL_PROXY_BUFFER_BYTES) {
          closeBoth(TRY_AGAIN_LATER, "terminal output consumer is too slow");
          return;
        }
        try {
          browserSocket.send(data, { binary: isBinary });
        } catch {
          closeBoth(TRY_AGAIN_LATER, "terminal output forwarding failed");
        }
      });
      runtimeSocket.on("close", (code, reason) => {
        try {
          browserSocket.close(
            code >= 1000 && code < 5000 ? code : TRY_AGAIN_LATER,
            reason.toString(),
          );
        } catch {
          /* already closed */
        }
      });
      runtimeSocket.on("error", () => closeBoth(TRY_AGAIN_LATER, "runtime connection failed"));
    },
  );
}

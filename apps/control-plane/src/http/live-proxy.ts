import websocketPlugin from "@fastify/websocket";
import { ClientPresenceSchema, RUNTIME_SUBPROTOCOL } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance } from "fastify";
import { Check } from "typebox/value";
import { WebSocket } from "ws";
import { withDeadline } from "../domain/dst.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";

const TRY_AGAIN_LATER = 1013;
const UNSUPPORTED_DATA = 1003;

let connectionCounter = 0;

/**
 * Live proxy (docs/runtime-protocol.md/docs/history-replication.md): after routing, text frames and close
 * signals are forwarded without interpretation; the runtime's `client.hello`
 * is the first application frame. A connection race or an unavailable runtime
 * closes with 1013 and the browser returns to the HTTP lifecycle API.
 *
 * Idle auto-stop (docs/lifecycle.md) carves out the only two content sniffs: presence
 * frames are consumed here (the runtime has no use for tab visibility), and
 * client requests refresh the advisory `last_busy_at` timestamp before being
 * forwarded unchanged.
 */
export async function registerLiveProxy(
  app: FastifyInstance,
  task: SimulationTask,
  deps: ControlPlaneDeps,
): Promise<void> {
  await app.register(websocketPlugin, {
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(RUNTIME_SUBPROTOCOL) ? RUNTIME_SUBPROTOCOL : false,
    },
  });

  app.get<{ Params: { orbId: string } }>(
    "/api/v1/orbs/:orbId/live",
    { websocket: true },
    async (browserSocket, request) => {
      const orbId = request.params.orbId;
      connectionCounter += 1;
      const connectionId = `browser-${connectionCounter}`;
      let upstream: WebSocket | null = null;
      let upstreamOpen = false;
      let browserClosed = false;
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
      deps.control.registerBrowserConnection(orbId, connectionId, () =>
        closeBoth(TRY_AGAIN_LATER, "orb is being deleted"),
      );

      // Attach handlers synchronously: the browser sends client.hello as soon
      // as its upgrade completes, while routing below crosses async adapter
      // boundaries. Queue frames until the runtime socket is open.
      browserSocket.on("message", (data: Buffer, isBinary: boolean) => {
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

      const orbResult = await deps.store.getOrb(task, orbId);
      if (
        orbResult.isErr() ||
        orbResult.value === null ||
        orbResult.value.state !== "running" ||
        deps.control.isStopping(orbId)
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
      if (browserClosed) return;

      const wsUrl = `${observed.value.runtimeAddress.baseUrl.replace(/^http/, "ws")}/v1/live`;
      const runtimeSocket = new WebSocket(wsUrl, [RUNTIME_SUBPROTOCOL]);
      upstream = runtimeSocket;

      runtimeSocket.on("open", () => {
        upstreamOpen = true;
        for (const message of pendingToUpstream) runtimeSocket.send(message);
        pendingToUpstream.length = 0;
      });
      runtimeSocket.on("message", (data, isBinary) => {
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
}

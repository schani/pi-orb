import { channel } from "node:diagnostics_channel";
import { lstatSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, Result } from "neverthrow";

const categories = new Set([
  "AbortError",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runtimeEntry = fileURLToPath(new URL("../../apps/orb-runtime/src/main.ts", import.meta.url));
const safe = (fn) => Result.fromThrowable(fn, () => ({ type: "audit_unavailable" }))();
const category = (error) => {
  for (const value of [error?.code, error?.name, error?.cause?.code])
    if (categories.has(value)) return value;
  return "other";
};

export function startAudit({ env = process.env, argv = process.argv, pid = process.pid } = {}) {
  const dir = env.PI_ORB_TEST_AUDIT_DIR;
  const entry = env.PI_ORB_TEST_AUDIT_ENTRY;
  const orb = env.PI_ORB_ID;
  if (
    !dir ||
    !isAbsolute(dir) ||
    !entry ||
    entry !== runtimeEntry ||
    argv[1] !== runtimeEntry ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !uuid.test(orb ?? "")
  )
    return err({ type: "audit_excluded" });
  const guard = safe(() => {
    const stat = lstatSync(dir);
    const origin = new URL(env.PI_ORB_TEST_AUDIT_ORIGIN);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === 0o700 &&
      stat.uid === process.getuid?.() &&
      origin.origin === env.PI_ORB_TEST_AUDIT_ORIGIN &&
      origin.protocol === "https:" &&
      origin.hostname === "fake-openai.flingit.run" &&
      env.PI_ORB_TEST_AUDIT_PATH?.startsWith("/")
    );
  });
  if (guard.isErr() || !guard.value) return err({ type: "audit_unavailable" });
  const file = join(dir, `${orb}-${pid}.json`);
  const requests = new WeakMap();
  const sockets = new WeakMap();
  const active = new Map();
  let sequence = 0;
  let requestSequence = 0;
  let socketSequence = 0;
  const started = performance.now();
  const configured = env.UV_THREADPOOL_SIZE;
  const pool =
    configured && /^[1-9][0-9]*$/.test(configured) && Number.isSafeInteger(Number(configured))
      ? Number(configured)
      : null;
  const snapshot = {
    version: 1,
    orb,
    pid,
    startup: {
      at: Date.now(),
      node: process.versions.node,
      undici: process.versions.undici ?? null,
      configuredThreadpoolSize: pool,
    },
    events: [],
    droppedCount: 0,
    activeRequests: [],
    activeDroppedCount: 0,
    callbackErrorCount: 0,
    writeErrorCount: 0,
  };
  const flush = () => {
    snapshot.activeRequests = [...active.values()].map((row) => ({ ...row }));
    const written = safe(() => {
      writeFileSync(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    });
    if (written.isErr()) snapshot.writeErrorCount++;
    return written;
  };
  if (flush().isErr()) return err({ type: "audit_unavailable" });
  const emit = (event, request = null, socket = null, status = null, error = null) => {
    const row = {
      sequence: ++sequence,
      event,
      at: Date.now(),
      elapsedMs: performance.now() - started,
      request,
      socket,
      status,
      error,
    };
    snapshot.events.push(row);
    if (snapshot.events.length > 64) {
      snapshot.events.shift();
      snapshot.droppedCount++;
    }
    if (request !== null && active.has(request))
      Object.assign(active.get(request), {
        lastEvent: event,
        lastAt: row.at,
        socket: socket ?? active.get(request).socket,
      });
    if (event === "error" || event === "trailers") active.delete(request);
    flush();
  };
  const subscriptions = [];
  const subscribe = (name, callback) => {
    const target = channel(`undici:${name}`);
    const handler = (message) => {
      const result = safe(() => callback(message));
      if (result.isErr()) {
        snapshot.callbackErrorCount++;
        flush();
      }
    };
    target.subscribe(handler);
    subscriptions.push(() => target.unsubscribe(handler));
  };
  const matches = (request) =>
    String(request.origin) === env.PI_ORB_TEST_AUDIT_ORIGIN &&
    request.path === env.PI_ORB_TEST_AUDIT_PATH;
  const connection = (params) =>
    params?.hostname === "fake-openai.flingit.run" && params?.protocol === "https:";
  subscribe("request:create", ({ request }) => {
    if (!matches(request)) return;
    const id = ++requestSequence;
    requests.set(request, id);
    if (active.size === 64) {
      active.delete(active.keys().next().value);
      snapshot.activeDroppedCount++;
    }
    active.set(id, {
      request: id,
      createdAt: Date.now(),
      lastAt: Date.now(),
      lastEvent: "request_create",
      socket: null,
    });
    emit("request_create", id);
  });
  subscribe("client:beforeConnect", ({ connectParams }) => {
    if (connection(connectParams)) emit("before_connect");
  });
  subscribe("client:connected", ({ connectParams, socket }) => {
    if (connection(connectParams)) {
      const id = ++socketSequence;
      sockets.set(socket, id);
      emit("connected", null, id);
    }
  });
  subscribe("client:connectError", ({ connectParams, error }) => {
    if (connection(connectParams)) emit("connect_error", null, null, null, category(error));
  });
  subscribe("client:sendHeaders", ({ request, socket }) => {
    const id = requests.get(request);
    if (id) {
      let socketId = sockets.get(socket);
      if (!socketId) {
        socketId = ++socketSequence;
        sockets.set(socket, socketId);
      }
      emit("send_headers", id, socketId);
    }
  });
  subscribe("request:headers", ({ request, response }) => {
    const id = requests.get(request);
    if (id)
      emit("headers", id, null, Number.isInteger(response.statusCode) ? response.statusCode : null);
  });
  subscribe("request:error", ({ request, error }) => {
    const id = requests.get(request);
    if (id) emit("error", id, null, null, category(error));
  });
  for (const [name, event] of [
    ["bodySent", "body_sent"],
    ["trailers", "trailers"],
  ])
    subscribe(`request:${name}`, ({ request }) => {
      const id = requests.get(request);
      if (id) emit(event, id);
    });
  return ok({
    file,
    stop: () => {
      for (const stop of subscriptions) stop();
    },
  });
}

// The same import reaches CP and inherited tools; the entrypoint/identity guard excludes both.
startAudit();

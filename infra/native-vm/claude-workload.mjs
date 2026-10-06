import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { join } from "node:path";
import { durableReceiptEdge, persistQualificationTrace } from "./claude-receipt-edge.mjs";

const [root, scratch, mode, hostNamespace] = process.argv.slice(2);
const sockets = new Set();
const workers = new Set();
let phase = "isolation";
let server;
let fixtureError;
let rejectFixture;
const fixtureFailure = new Promise((_, reject) => {
  rejectFixture = reject;
});
let requestCount = 0;
let grants = 0;
let mcpCalls = 0;
let interrupted;
const interruptedRequest = new Promise((resolve) => {
  interrupted = resolve;
});
const checks = {};
const startedAt = new Date().toISOString();
const started = performance.now();
const phases = [];
const nativeEdges = [];
const evidence = {};
let traceWriteFailed = false;
const syntheticBearer = "synthetic-subscription-not-a-credential";
function progress() {
  return {
    phase,
    elapsedMs: Math.round(performance.now() - started),
    modelRequests: requestCount,
    grants,
    mcpCalls,
  };
}
function persistProgress() {
  const saved = persistQualificationTrace(join(scratch, "progress.json"), {
    kind: "claude_qualification_failure_trace",
    schemaVersion: 1,
    ...progress(),
    startedAt,
    phases,
    nativeEdges,
    evidence,
  });
  if (saved.isErr() && !traceWriteFailed) {
    traceWriteFailed = true;
    process.exitCode = 1;
    process.stderr.write("CLAUDE_ACCEPTANCE_TRACE_WRITE_FAILED\n");
  }
}
function advance(next) {
  phase = next;
  phases.push(progress());
  persistProgress();
}
advance("isolation");

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
// Same native Messages SSE grammar as scripts/claude-sdk-contract/probe.mjs.
function message(response, block, stopReason) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", {
    message: {
      id: `msg_synthetic_${requestCount}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 16, output_tokens: 0 },
    },
  });
  const tool = block.type === "tool_use";
  emit("content_block_start", {
    index: 0,
    content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
  });
  emit("content_block_delta", {
    index: 0,
    delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text },
  });
  emit("content_block_stop", { index: 0 });
  emit("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  emit("message_stop", {});
  response.end();
}
async function paths(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? paths(join(directory, entry.name)) : [join(directory, entry.name)],
      ),
    )
  ).flat();
}
function receipt(snapshot, messageId) {
  const matching = snapshot.records.filter(
    (record) =>
      record.type === "message" &&
      record.role === "user" &&
      record.inboxMessageIds?.includes(messageId),
  );
  assert.equal(matching.length, 1, "durable inbox receipt was lost or duplicated");
  return matching[0];
}
function worker(workDir, origin, certificate, incarnation) {
  const child = spawn(
    process.execPath,
    [
      new URL("./claude-worker.mjs", import.meta.url).pathname,
      root,
      workDir,
      origin,
      origin,
      incarnation,
    ],
    {
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: join(workDir, "home"),
        TMPDIR: scratch,
        NODE_EXTRA_CA_CERTS: certificate,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        PI_ORB_CONTAINER: "1",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  workers.add(child);
  const pending = new Map();
  let sequence = 0;
  const ready = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("owned runtime spawn failed")));
    child.on("message", (reply) => {
      if (reply.qualificationEvidence) {
        const observation = reply.qualificationEvidence;
        if (["1", "2", "3"].includes(observation.incarnation))
          evidence[observation.incarnation] = observation;
        persistProgress();
        return;
      }
      if (reply.nativeEdge) {
        assert(nativeEdges.length < 256, "native edge diagnostic exceeded fixture bound");
        nativeEdges.push({ ...reply.nativeEdge, elapsedMs: progress().elapsedMs });
        persistProgress();
        return;
      }
      if (reply.ready) {
        resolve();
        return;
      }
      const promise = pending.get(reply.id);
      pending.delete(reply.id);
      if (!promise) return;
      if (reply.error) promise.reject(new Error(reply.error));
      else promise.resolve(reply.result);
    });
    child.once("close", () => {
      reject(new Error("owned runtime exited before ready"));
      for (const promise of pending.values())
        promise.reject(new Error("owned runtime exited during command"));
      pending.clear();
      workers.delete(child);
    });
  });
  return {
    child,
    async call(method, params = {}) {
      await ready;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.send({ id, method, ...params });
      return result;
    },
    async close(crash = false) {
      const ended = once(child, "close");
      if (crash) process.kill(-child.pid, "SIGKILL");
      else await this.call("close");
      await ended;
    },
  };
}
async function run() {
  // The wrapper enters fresh PID/network namespaces before this process or any
  // broker/model/runtime/tool exists. There is no host route, NAT or metadata.
  const interfaces = JSON.parse(
    execFileSync("ip", ["-json", "link", "show"], { encoding: "utf8" }),
  );
  assert.deepEqual(
    interfaces.map((item) => item.ifname),
    ["lo"],
  );
  assert.equal(process.getuid(), 2000);
  assert.equal(process.pid, 1);
  assert.notEqual(await readlink("/proc/self/ns/net"), hostNamespace);
  checks.networkNamespace = true;
  const denied = await new Promise((resolve) => {
    const socket = createConnection({ host: "169.254.169.254", port: 80 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
  assert.equal(denied, true, "metadata network was reachable");
  checks.externalNetworkDenied = true;

  advance("fixture");
  const workDir = await mkdtemp(join(scratch, "retained-"));
  const repository = join(workDir, "repo");
  await mkdir(join(repository, ".agents"), { recursive: true });
  await writeFile(join(repository, "README.md"), "Synthetic Claude acceptance fixture.\n");
  await writeFile(
    join(repository, ".agents", "setup"),
    "#!/bin/sh\nprintf 'setup\\n' >> ../setup-count\n",
    { mode: 0o755 },
  );
  await writeFile(
    join(repository, ".agents", "resume"),
    "#!/bin/sh\nprintf 'resume\\n' >> ../resume-count\n",
    { mode: 0o755 },
  );
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Qualification",
      "-c",
      "user.email=qualification@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    execFileSync("git", args, {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "ignore",
    });
  }
  const key = join(scratch, "fixture-key.pem");
  const certificate = join(scratch, "fixture-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let origin;
  server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    async (request, response) => {
      let contractStage = "body";
      try {
        let text = "";
        for await (const chunk of request) {
          text += chunk;
          assert(text.length < 2 * 1024 * 1024, "synthetic request exceeded fixture limit");
        }
        const path = request.url.split("?")[0];
        if (path.startsWith("/runtime/")) {
          contractStage = "broker";
          assert.equal(request.headers.authorization, "Bearer synthetic-runtime-authority");
          if (request.method === "GET" && path === "/runtime/v1/project-secrets")
            return json(response, 200, { revision: 0, values: {} });
          if (request.method === "GET" && path === "/runtime/v1/mcp")
            return json(response, 200, {
              revision: 0,
              servers: [
                {
                  name: "qualification",
                  description: "Owned synthetic MCP",
                  url: `${origin}/mcp`,
                  headers: { Authorization: { literal: "synthetic-mcp-authority" } },
                },
              ],
            });
          if (
            request.method === "GET" &&
            ["/runtime/v1/personal-instructions", "/runtime/v1/project-instructions"].includes(path)
          )
            return json(response, 200, { content: "", revision: 0 });
          if (request.method === "POST" && path === "/runtime/v1/orb/boot-context")
            return json(response, 200, { v: 1, context: null, userTimeZone: null });
          if (request.method === "POST" && path === "/runtime/v1/claude-subscription") {
            assert.equal(text, "{}");
            grants++;
            persistProgress();
            return json(response, 200, { token: syntheticBearer, generation: 1 });
          }
          assert.fail("unrecognized broker route");
        }
        if (path === "/mcp") {
          contractStage = `mcp_auth_${["POST", "GET", "DELETE"].includes(request.method) ? request.method.toLowerCase() : "other"}`;
          assert.equal(request.headers.authorization, "synthetic-mcp-authority");
          if (request.method === "GET" || request.method === "DELETE")
            return json(response, 405, {});
          assert.equal(request.method, "POST");
          const rpc = JSON.parse(text);
          contractStage = `mcp_rpc_${typeof rpc.method === "string" && /^[a-z]+(?:\/[A-Za-z]+){0,2}$/.test(rpc.method) ? rpc.method.replaceAll("/", "_") : "other"}`;
          if (rpc.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          let result;
          if (rpc.method === "initialize")
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic", version: "1" },
            };
          else if (rpc.method === "tools/list")
            result = {
              tools: [
                {
                  name: "sentinel",
                  description: "Return the fixture sentinel",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            };
          else if (rpc.method === "tools/call") {
            assert.equal(rpc.params.name, "sentinel");
            mcpCalls++;
            persistProgress();
            result = { content: [{ type: "text", text: "native-mcp-sentinel" }] };
          } else if (rpc.method === "ping") result = {};
          else
            return json(response, 200, {
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: "Method not found" },
            });
          return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
        }
        if (request.method === "HEAD" && path === "/api/hello") {
          response.writeHead(200);
          response.end();
          return;
        }
        if (path === "/v1/messages/count_tokens") return json(response, 200, { input_tokens: 16 });
        contractStage = "model_route";
        assert.equal(path, "/v1/messages", "unexpected native model route");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, `Bearer ${syntheticBearer}`);
        assert.equal(request.headers["x-api-key"], undefined);
        const body = JSON.parse(text);
        const history = JSON.stringify(body.messages);
        requestCount++;
        persistProgress();
        const users = body.messages.filter((item) => item.role === "user");
        let operation;
        for (const item of users) {
          const serialized = JSON.stringify(item.content);
          for (const candidate of ["completed", "interrupted", "continue"])
            if (serialized.includes(`[qualification:${candidate}]`)) operation = candidate;
        }
        if (operation === "interrupted") {
          interrupted();
          return;
        }
        if (operation === "continue") {
          contractStage = "continued_history";
          assert(history.includes("[qualification:completed]"));
          assert(history.includes("[qualification:interrupted]"));
          assert(
            history.includes("native-mcp-sentinel"),
            "native retained tool history was absent",
          );
          return message(
            response,
            { type: "text", text: "Manual continuation complete." },
            "end_turn",
          );
        }
        assert.equal(operation, "completed");
        if (!history.includes("toolu_native_bash"))
          return message(
            response,
            {
              type: "tool_use",
              id: "toolu_native_bash",
              name: "Bash",
              input: {
                command: "printf 'bash\\n' >> ../native-tool-count; printf native-bash-sentinel",
                description: "Write the owned fixture sentinel",
              },
            },
            "tool_use",
          );
        if (!history.includes("toolu_native_mcp"))
          return message(
            response,
            {
              type: "tool_use",
              id: "toolu_native_mcp",
              name: "mcp__qualification__sentinel",
              input: {},
            },
            "tool_use",
          );
        assert(history.includes("native-bash-sentinel"));
        assert(history.includes("native-mcp-sentinel"));
        return message(response, { type: "text", text: "Synthetic tools complete." }, "end_turn");
      } catch (error) {
        fixtureError = `synthetic_${contractStage}_${error.code === "ECONNRESET" ? "reset" : "contract_failed"}`;
        json(response, 500, { error: fixtureError });
        rejectFixture(new Error("synthetic_endpoint_contract_failed"));
      }
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `https://127.0.0.1:${server.address().port}`;

  advance("boot");
  let runtime = worker(workDir, origin, certificate, "1");
  const boot = await runtime.call("boot");
  assert.equal(boot.started, boot.exited);
  assert.equal(boot.nativeProcesses, 0);
  assert.equal(requestCount, 0, "boot performed automatic inference");
  checks.subscriptionSource = boot.accountChecked;
  checks.nativeBoot = true;

  advance("native-tools-and-drain");
  await runtime.call("deliver", {
    messageId: "inbox-completed",
    content: "[qualification:completed] Run the fixture tools.",
  });
  const completed = await runtime.call("idle");
  assert.equal(requestCount, 3);
  assert.equal(mcpCalls, 1);
  assert.equal(await readFile(join(workDir, "native-tool-count"), "utf8"), "bash\n");
  const firstReceipt = receipt(completed.snapshot, "inbox-completed");
  assert(
    completed.snapshot.records.some(
      (record) => record.type === "message" && record.role === "assistant",
    ),
  );
  const duplicate = await runtime.call("deliver", {
    messageId: "inbox-completed",
    content: "[qualification:completed] Run the fixture tools.",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, "persisted");
  assert.equal(requestCount, 3);
  checks.nativeBash = true;
  checks.nativeMcp = true;
  checks.inputReceipt = true;
  checks.pullHistory = true;
  checks.supervisedDrain = true;
  const nativePaths = await paths(join(workDir, "claude", "config"));
  const rootPath = nativePaths.find((path) =>
    path.endsWith(`/${completed.snapshot.session.id}.jsonl`),
  );
  assert(rootPath, "native root file missing");
  const originalPrefix = await readFile(rootPath, "utf8");
  const nativeRows = originalPrefix
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(nativeRows.filter((row) => row.uuid === firstReceipt.id).length, 1);
  await runtime.close();
  advance("graceful-stopped");

  advance("retained-restart");
  runtime = worker(workDir, origin, certificate, "2");
  const retained = await runtime.call("boot");
  assert.equal(retained.snapshot.session.id, completed.snapshot.session.id);
  assert.equal(receipt(retained.snapshot, "inbox-completed").id, firstReceipt.id);
  assert.deepEqual(
    retained.snapshot.records.slice(0, completed.snapshot.records.length),
    completed.snapshot.records,
  );
  assert.equal(requestCount, 3, "retained boot replayed previous work");
  checks.retainedSession = true;

  advance("known-receipt-crash");
  const nativeEdge = durableReceiptEdge(
    rootPath,
    join(workDir, "claude", "session.json"),
    "inbox-interrupted",
  );
  try {
    await runtime.call("deliver", {
      messageId: "inbox-interrupted",
      content: "[qualification:interrupted] Wait for explicit continuation.",
    });
    await nativeEdge.inspect();
    await nativeEdge.promise;
    advance("known-receipt-durable");
  } finally {
    nativeEdge.close();
  }
  await interruptedRequest;
  advance("known-receipt-observation");
  const inFlight = await runtime.call("snapshot");
  const interruptedReceipt = receipt(inFlight.snapshot, "inbox-interrupted");
  assert.equal(inFlight.snapshot.activity, "busy");
  if (mode === "fail-in-flight") throw new Error("forced_fixture_failure");
  advance("known-receipt-kill");
  await runtime.close(true);
  advance("known-receipt-killed");

  advance("manual-recovery");
  runtime = worker(workDir, origin, certificate, "3");
  const recovered = await runtime.call("boot");
  advance("manual-recovery-receipts");
  assert.equal(requestCount, 4, "interrupted boot automatically replayed work");
  assert.equal(recovered.snapshot.session.id, completed.snapshot.session.id);
  assert.equal(receipt(recovered.snapshot, "inbox-interrupted").id, interruptedReceipt.id);
  advance("manual-recovery-notice");
  assert(
    recovered.snapshot.records.some(
      (record) => record.type === "event" && record.eventType === "claude.operation_interrupted",
    ),
  );
  advance("manual-recovery-dedup");
  const old = await runtime.call("deliver", {
    messageId: "inbox-interrupted",
    content: "[qualification:interrupted] Wait for explicit continuation.",
  });
  assert.equal(old.duplicate, true);
  assert.equal(old.status, "persisted");
  assert.equal(requestCount, 4);
  advance("manual-continuation");
  await runtime.call("deliver", {
    messageId: "inbox-continue",
    content: "[qualification:continue] Continue manually.",
  });
  const continued = await runtime.call("idle");
  advance("continued-receipts");
  assert.equal(requestCount, 5);
  receipt(continued.snapshot, "inbox-completed");
  receipt(continued.snapshot, "inbox-interrupted");
  receipt(continued.snapshot, "inbox-continue");
  assert.deepEqual(
    continued.snapshot.records.slice(0, completed.snapshot.records.length),
    completed.snapshot.records,
  );
  advance("native-prefix-retention");
  assert((await readFile(rootPath, "utf8")).startsWith(originalPrefix));
  assert.equal(await readFile(join(workDir, "native-tool-count"), "utf8"), "bash\n");
  assert.equal(grants, 3);
  checks.manualContinuation = true;
  checks.noAutomaticReplay = true;
  checks.noDuplicateReceipt = true;
  await runtime.close();
  advance("hook-retention");
  assert.equal(await readFile(join(workDir, "setup-count"), "utf8"), "setup\nsetup\nsetup\n");
  assert.equal(await readFile(join(workDir, "resume-count"), "utf8"), "resume\nresume\nresume\n");
  checks.hooks = true;
  assert.equal(fixtureError, undefined);
}
let passed = false;
try {
  await Promise.race([run(), fixtureFailure]);
  passed = true;
} catch (error) {
  const runtimeCode = /^(?:synthetic_runtime_[a-z_]+|forced_fixture_failure)$/.test(
    error.message ?? "",
  )
    ? error.message
    : "assertion";
  process.stderr.write(
    `CLAUDE_ACCEPTANCE_FAILED phase=${phase} code=${fixtureError ?? runtimeCode} modelRequests=${requestCount} grants=${grants} mcpCalls=${mcpCalls}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const child of workers) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") process.exitCode = 1;
    }
  }
  await Promise.all([...workers].map((child) => once(child, "close")));
  for (const socket of sockets) socket.destroy();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}
if (passed && process.exitCode !== 1)
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, syntheticOnly: true, billingQualified: false, organizationPolicyQualified: false, checks, timing: { startedAt, elapsedMs: progress().elapsedMs, phases, nativeEdges } })}\n`,
  );

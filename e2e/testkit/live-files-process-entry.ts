import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutionServer } from "../../apps/orb-runtime/src/execution/server.ts";

const orbId = process.env["PI_ORB_ID"];
const token = process.env["PI_ORB_RUNTIME_TOKEN"];
const incarnation = process.env["PI_ORB_HOST_INCARNATION"];
const workspace = process.env["PI_ORB_WORK_DIR"];
if (!orbId || !token || !incarnation || !workspace) throw new Error("Provider identity missing");
const cwd = join(workspace, "repo");
await mkdir(cwd, { recursive: true });
const app = buildExecutionServer({ token, incarnation, cwd });
await app.listen({ host: "127.0.0.1", port: Number(process.env["PI_ORB_RUNTIME_PORT"]) });
process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));

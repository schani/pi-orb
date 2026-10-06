#!/usr/bin/python3
"""Test-owned privilege broker; no host accounts, sudoers or capabilities change."""
import json
import os
import signal
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

wrapper = Path(sys.argv[1]).resolve()
parent = Path(sys.argv[2]).resolve()
candidate = Path(sys.argv[3]).resolve()
foreign_uid = 62000
results = []

for workload_status, cleanup_status in [(0, 0), (37, 0), (37, 73), (0, 73), (137, 0)]:
    directory = Path(tempfile.mkdtemp(prefix="foreign-uid-", dir=parent))
    base = directory / "scratch-parent"
    helpers = directory / "helpers"
    tools = directory / "tools"
    retained = directory / "retained"
    for path in [base, helpers, tools, retained]:
        path.mkdir(mode=0o755)
        path.chmod(0o755)
    directory.chmod(0o755)
    os.chown(base, foreign_uid, foreign_uid)
    os.chown(retained, foreign_uid, foreign_uid)
    sentinel = base / "user-file"
    sentinel.write_text("untouched")
    shutil.copyfile(wrapper, helpers / "claude-acceptance.sh")
    (helpers / "claude-acceptance.sh").chmod(0o755)
    shutil.copyfile(wrapper.parent / "claude-receipt-edge.mjs", helpers / "claude-receipt-edge.mjs")
    (helpers / "claude-receipt-edge.mjs").chmod(0o644)
    (helpers / "claude-workload.mjs").write_text('''
import { mkdirSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { safeQualificationEvidence, persistQualificationTrace } from "./claude-receipt-edge.mjs";
const scratch = process.argv[3];
if (process.getuid() !== 2000 || (statSync(scratch).mode & 0o777) !== 0o700)
  process.exit(91);
mkdirSync(join(scratch, "private"), { mode: 0o700 });
writeFileSync(join(scratch, "private", "receipt"), "synthetic", { mode: 0o600 });
symlinkSync(join(dirname(scratch), "user-file"), join(scratch, "private", "link"));
const privateValue = "PRIVATE_PROVIDER_TOKEN_URL_CODE_ENV_CONTENT";
const id = "00000000-0000-4000-8000-000000000029";
const evidence = safeQualificationEvidence({ health: { status: "failed", error: { code: "claude_stream_identity_gap", message: privateValue } }, nativeRows: [{ uuid: id, type: "assistant", sessionId: id, message: { content: privateValue } }] });
const saved = persistQualificationTrace(join(scratch, "progress.json"), { kind: "claude_qualification_failure_trace", phase: "fixture-owned-failure", modelRequests: 0, evidence, nativeEdges: [{ event: "native-stdout-eof" }, { event: "sdk-iterator-eof" }] });
if (saved.isErr()) process.exit(92);
if (''' + str(workload_status) + ''' === 137) {
  console.log("owned-durable-checkpoint");
  await new Promise(() => { setInterval(() => {}, 60000); });
}
process.exit(''' + str(workload_status) + ''');
''')
    (helpers / "claude-workload.mjs").chmod(0o644)
    address = str(directory / "privilege.sock")
    server = socket.socket(socket.AF_UNIX)
    server.bind(address)
    os.chmod(address, 0o666)
    server.listen()
    (tools / "sudo").write_text('''#!/usr/bin/python3
import json, socket, sys
client = socket.socket(socket.AF_UNIX)
client.connect(''' + repr(address) + ''')
client.sendall(json.dumps(sys.argv[3:]).encode() + b"\\n")
reader = client.makefile("rb")
reply = json.loads(reader.readline())
sys.stdout.write(reply["stdout"])
sys.stderr.write(reply["stderr"])
sys.exit(reply["status"])
''')
    (tools / "sudo").chmod(0o755)
    operations = []
    stopped = threading.Event()

    def broker():
        while not stopped.is_set():
            connection, _ = server.accept()
            with connection:
                args = json.loads(connection.makefile("rb").readline())
                if not args:
                    break
                command = "rm" if args[0:4] == ["timeout", "--kill-after=1s", "5s", "rm"] else args[0]
                assert command in ["chown", "timeout", "cat", "rm", "test"], args
                if command in ["chown", "rm", "cat", "test"]:
                    target = Path(args[-1])
                    assert target.parent == base or target.parent.parent == base, args
                    assert ".pi-orb-claude-acceptance." in str(target), args
                else:
                    assert str(helpers) in args and str(candidate) in args, args
                    assert "--net" in args and "--pid" in args and "--mount-proc" in args, args
                operations.append(command)
                if command == "rm" and cleanup_status:
                    reply = {"status": cleanup_status, "stdout": "", "stderr": "injected_cleanup_failure\n"}
                elif command == "timeout" and workload_status == 137:
                    child = subprocess.Popen(args[3:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                    assert child.stdout.readline().strip() == "owned-durable-checkpoint"
                    os.killpg(child.pid, signal.SIGKILL)
                    stdout, stderr = child.communicate(timeout=15)
                    reply = {"status": 137, "stdout": stdout, "stderr": stderr}
                else:
                    completed = subprocess.run(args, capture_output=True, text=True, timeout=15)
                    reply = {"status": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
                connection.sendall(json.dumps(reply).encode() + b"\n")

    thread = threading.Thread(target=broker, daemon=True)
    thread.start()
    try:
        completed = subprocess.run(
            ["setpriv", "--reuid=" + str(foreign_uid), "--regid=" + str(foreign_uid),
             "--clear-groups", "bash", str(helpers / "claude-acceptance.sh"),
             str(candidate), str(base), "accept", str(retained)],
            cwd=candidate, env={"PATH": str(tools) + ":/usr/local/bin:/usr/bin:/bin"},
            capture_output=True, text=True, timeout=20,
        )
        leftovers = [p.name for p in base.iterdir() if p.name != "user-file"]
        traces = list(retained.iterdir())
        assert len(traces) == (1 if workload_status else 0), {
            "exit": completed.returncode, "traceCount": len(traces),
            "expectedTraceCount": 1 if workload_status else 0,
        }
        retained_trace = json.loads(traces[0].read_text()) if traces else None
        results.append({"workloadStatus": workload_status, "cleanupStatus": cleanup_status,
                        "stdout": completed.stdout, "retainedTrace": retained_trace,
                        "exit": completed.returncode, "stderr": completed.stderr,
                        "leftovers": len(leftovers), "sentinel": sentinel.read_text(),
                        "operations": operations, "callerUid": foreign_uid})
    finally:
        stopped.set()
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(address)
            client.sendall(b"[]\n")
        thread.join(timeout=2)
        server.close()
        shutil.rmtree(directory)

print(json.dumps(results))

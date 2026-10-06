"""Linux process-host ownership boundary, including detached tool descendants.

The runtime may die first. This process remains their subreaper until every
adopted child is killed and reaped; only then may the provider report absence.
"""
import ctypes
import os
import json
import signal
import subprocess
import sys
import time

if sys.argv[1] == "--signal":
    pid, birth = int(sys.argv[2]), sys.argv[3]
    try:
        fd = os.pidfd_open(pid)
        with open(f"/proc/{pid}/stat", encoding="ascii") as stat:
            actual = stat.read().rsplit(")", 1)[1].split()[19]
        if actual == birth:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        os.close(fd)
    except (ProcessLookupError, FileNotFoundError):
        pass
    sys.exit(0)

proof_path, launch_token = sys.argv[1:3]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "cannot establish execution subreaper")

closing = False


def shutdown(_signum, _frame):
    global closing
    closing = True


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)


def receipt(path):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="ascii") as proof:
        json.dump({"launch": launch_token}, proof)
        proof.flush()
        os.fsync(proof.fileno())
    os.replace(temporary, path)


probe = os.pidfd_open(os.getpid())
os.close(probe)
receipt(proof_path + ".ready")
channel = os.environ.get("NODE_CHANNEL_FD")
child = subprocess.Popen(sys.argv[3:], pass_fds=(() if channel is None else (int(channel),)))
if channel is not None:
    os.close(int(channel))
runtime_pid = child.pid
runtime_status = None

while True:
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            pid = 0
        if pid == 0:
            break
        if pid == runtime_pid:
            runtime_status = status
            closing = True
    if closing:
        # Unreaped direct children cannot have their PID reused. pidfds also
        # bind delivery to that birth, even if the child exits during the send.
        with open(f"/proc/self/task/{os.getpid()}/children", encoding="ascii") as children:
            pids = [int(pid) for pid in children.read().split()]
        if not pids:
            break
        for pid in pids:
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
    time.sleep(0.005)

receipt(proof_path)
print("execution supervisor: descendants drained", file=sys.stderr, flush=True)
sys.exit(os.waitstatus_to_exitcode(runtime_status) if runtime_status is not None and runtime_status >= 0 and os.WIFEXITED(runtime_status) else 1)

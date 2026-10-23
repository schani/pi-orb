"""Private failure evidence and child ownership for the offline replacement test."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time

FAILURES = Path(__file__).resolve().parents[1] / '.context/smoke-replacement-failures'


def read_owned(path, limit):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                return None
            return source.read(limit + 1).decode('utf-8')
    except (OSError, UnicodeError):
        return None


def capture_failure(root, mode, stage2, elapsed, pid, joined):
    state = {}
    try:
        raw = json.loads(read_owned(root / 'state.json', 4096) or '{}')
        if isinstance(raw, dict):
            if raw.get('state') in {'running', 'failed', 'stopped'}:
                state['state'] = raw['state']
            for key in ('starts', 'incarnation', 'sensitive_jq_inputs', 'clock_calls', 'failed_lists'):
                value = raw.get(key)
                if type(value) is int and 0 <= value <= 10000:
                    state[key] = value
            for key in ('stage2', 'deleted', 'project_created', 'orb_created'):
                if type(raw.get(key)) is bool:
                    state[key] = raw[key]
    except (ValueError, TypeError):
        pass
    counts, last = {}, None
    commands = read_owned(root / 'commands.jsonl', 1024 * 1024)
    incomplete = commands is None
    for line in (commands or '').splitlines()[:4096]:
        try:
            if len(line) > 16384:
                incomplete = True
                continue
            command = json.loads(line)
            if not isinstance(command, list) or not command:
                raise ValueError()
            name = command[0]
            category = name if name in {'curl', 'jq', 'sleep', 'date', 'fake-stage2'} else 'other'
            if name == 'gcloud':
                if command[1:3] == ['auth', 'print-identity-token']:
                    category = 'auth'
                elif command[1:3] == ['compute', 'ssh']:
                    category = 'ssh'
                elif command[1:4] in [
                    ['compute', kind, verb] for kind in ('instances', 'disks') for verb in ('list', 'describe')
                ]:
                    category = command[2] + '-' + command[3]
            counts[category] = counts.get(category, 0) + 1
            last = category
        except (ValueError, TypeError):
            incomplete = True
    if commands is not None and len(commands.splitlines()) > 4096:
        incomplete = True
    summary = dict(outcome='timeout', budget=90, elapsed=round(elapsed, 3), pid=pid, pgid=pid,
                   mode='large-metadata' if mode == 'large-metadata' else 'other', stage2=stage2,
                   state=state, counts=counts, last_started=last, incomplete=incomplete, joined=joined)
    FAILURES.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='timeout-', dir=FAILURES))
    path = directory / 'summary.json'
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        json.dump(summary, output)
    return path


def run_fixture(command, env, root, mode, stage2):
    owner = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(root), *command],
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    started = time.monotonic()
    try:
        stdout, stderr = owner.communicate(timeout=90)
        receipt = json.loads(read_owned(root / 'owner.json', 1024) or '{}')
        code = owner.returncode
        if sys.platform == 'linux' and receipt.get('joined') is not True and code == 0:
            code = 125
        return subprocess.CompletedProcess(command, code, stdout, stderr)
    except subprocess.TimeoutExpired as primary:
        try:
            owner.send_signal(signal.SIGTERM)
            owner.communicate(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                owner.kill()
                owner.communicate(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                primary.add_note('replacement fixture owner could not be joined')
        finally:
            try:
                joined = json.loads(read_owned(root / 'owner.json', 1024) or '{}').get('joined') is True
                capture_failure(root, mode, stage2, time.monotonic() - started, owner.pid, joined)
            except (OSError, ValueError, TypeError):
                primary.add_note('replacement fixture diagnostic capture failed')
        raise primary


def own(root, command):
    # A dedicated subreaper owns only this fixture, including SSH/deploy sessions.
    linux = sys.platform == 'linux'
    if linux:
        import ctypes
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise OSError('could not own replacement fixture descendants')
    def terminate(_signal, _frame):
        raise SystemExit(124)
    signal.signal(signal.SIGTERM, terminate)
    child = subprocess.Popen(command, start_new_session=True)
    try:
        return child.wait()
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        joined = False
        if linux:
            joined = True
            children = Path(f'/proc/self/task/{os.getpid()}/children')
            until = time.monotonic() + 1
            while children.read_text().strip():
                for pid in map(int, children.read_text().split()):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                while True:
                    try:
                        if os.waitpid(-1, os.WNOHANG)[0] == 0:
                            break
                    except ChildProcessError:
                        break
                if time.monotonic() >= until:
                    joined = False
                    break
                time.sleep(0.001)
        with os.fdopen(os.open(root / 'owner.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as receipt:
            json.dump({'joined': joined, 'subreaper': linux}, receipt)


if __name__ == '__main__':
    sys.exit(own(Path(sys.argv[1]), sys.argv[2:]))

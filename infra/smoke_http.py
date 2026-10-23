#!/usr/bin/env python3
"""Classified, bounded external operations for lifecycle/identity smokes."""
import email.utils
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

RETRY_HTTP = {"408", "429", "500", "502", "503", "504"}
RETRY_CURL = {5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92, 95}
UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"


def retryable(code, status, body):
    category, allowed = http_category(code, status, body)
    if not allowed and category not in {"http", "http_terminal"}:
        return False
    if status in {"401", "403", "404"}:
        return False
    if code:
        return allowed
    try:
        error = json.loads(body).get("error")
        if isinstance(error, dict) and isinstance(error.get("retryable"), bool):
            return error["retryable"]
    except (ValueError, AttributeError, UnicodeError):
        pass
    return allowed


def fixed_id_create(path, body):
    if not re.fullmatch(r"/api/v1/projects(?:/" + UUID + r"/orbs)?", path):
        return False
    try:
        return re.fullmatch(UUID, json.loads(body).get("id", "")) is not None
    except (ValueError, AttributeError, TypeError):
        return False


def retry_after(headers):
    values = re.findall(r"(?im)^retry-after:\s*([^\r\n]+)", headers)
    if not values:
        return 0
    value = values[-1].strip()
    if value.isdigit():
        return int(value)
    try:
        return max(0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
    except (ValueError, TypeError, OverflowError):
        return 0


TRANSIENT = {"resource_exhausted", "unavailable", "deadline_exceeded", "timeout",
             "dns_temporary", "connection_reset", "connection_refused", "iap_not_ready"}
PROCESS_PHASES = {"auth": "auth", "fixture-auth": "auth", "instances-list": "cloud", "instance-describe": "cloud",
                  "resource-names": "cloud", "disk-describe": "cloud", "stage2-deploy": "deploy",
                  "tofu-app": "config", "tofu-issuer": "config",
                  **{f"ssh-{step}": "ssh" for step in ("ready", "preview", "mint", "environment", "probe", "replacement")}}


TERMINAL_MARKERS = (
    ("permission_denied", r"\bPERMISSION_DENIED\b|Permission denied|does not have permission"),
    ("unauthenticated", r"\bUNAUTHENTICATED\b"),
    ("invalid_grant", r"\binvalid_grant\b"),
    ("invalid_target", r"\binvalid_target\b"),
    ("unauthorized_client", r"\bunauthorized_client\b"),
    ("tls", r"CERTIFICATE_VERIFY_FAILED|certificate verify failed|certificate has expired"),
    ("host_key", r"REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed"),
    ("dns_permanent", r"Name or service not known|nodename nor servname provided"),
)

def terminal_diagnostic(stderr):
    diagnostic = stderr.decode(errors="replace")
    return any(re.search(pattern, diagnostic, re.IGNORECASE) for _, pattern in TERMINAL_MARKERS)


def auth_error(stderr):
    diagnostic = stderr.decode(errors="replace")
    terminal = set()
    transient = set()
    for category, pattern in TERMINAL_MARKERS:
        if re.search(pattern, diagnostic, re.IGNORECASE):
            terminal.add(category)
    if terminal:
        return next(iter(terminal)) if len(terminal) == 1 else "unknown"
    for category, pattern in (
        ("resource_exhausted", r"\bRESOURCE_EXHAUSTED\b"),
        ("unavailable", r"\bUNAVAILABLE\b"),
        ("deadline_exceeded", r"\bDEADLINE_EXCEEDED\b"),
        ("dns_temporary", r"Temporary failure in name resolution|\bEAI_AGAIN\b"),
        ("timeout", r"\b(?:ReadTimeout|ConnectTimeout|TimeoutError)\b"),
        ("connection_reset", r"ConnectionResetError|Connection reset by peer"),
        ("connection_refused", r"Connection refused"),
        ("iap_not_ready", r"Error while connecting \[4003: failed to connect to backend\]"),
    ):
        if re.search(pattern, diagnostic, re.IGNORECASE):
            transient.add(category)
    return next(iter(transient)) if len(transient) == 1 else "unknown"


def ssh_run(args, **kwargs):
    # gcloud owns an SSH/IAP descendant tree. Kill the owned group even if its
    # leader exits first; communicate joins/reaps the leader with a fixed bound.
    timeout = kwargs.pop("timeout")
    data = kwargs.pop("input", None)
    kwargs.pop("capture_output", None)
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True, **kwargs)
    try:
        stdout, stderr = process.communicate(data, timeout=timeout)
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate(timeout=2)


def relay_diagnostics(stderr):
    for line in stderr.decode(errors="replace").splitlines():
        if line.startswith("identity-mint: "):
            try:
                event = json.loads(line.removeprefix("identity-mint: "))
                if not isinstance(event, dict) or event.get("event") not in {"attempt", "result", "retry", "budget_exhausted"}:
                    continue
                clean = {"event": event["event"]}
                for key in ("attempt", "elapsedMs", "timeoutMs", "retryAfterMs", "waitMs"):
                    value = event.get(key)
                    if type(value) in {int, float} and 0 <= value <= 3600000:
                        clean[key] = value
                if event.get("outcome") in {"token", "invalid_request", "unauthorized", "not_mintable", "rate_limited", "retryable", "internal"}:
                    clean["outcome"] = event["outcome"]
                print("identity-mint: " + json.dumps(clean, separators=(",", ":")), file=sys.stderr)
            except (ValueError, TypeError):
                pass
        elif line.startswith("smoke-http: "):
            fields = line.removeprefix("smoke-http: ").split()
            allowed = {"operation": {"probe", "preview"}, "phase": {"http"},
                       "error": {"timeout", "http_transient", "http_terminal", "transport_transient", "transport_terminal", "unknown", "json", "not_ready", "ok", "exec", "typed_terminal"},
                       "outcome": {"retry", "recovered", "terminal", "unknown", "exhausted", "deadline"}}
            numeric = {"attempt", "exit", "http", "elapsed_s", "remaining_s", "delay_s"}
            valid = True
            for field in fields:
                key, sep, value = field.partition("=")
                if not sep or not (value in allowed.get(key, set()) or key in numeric and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value)):
                    valid = False
            if valid and fields:
                print(line, file=sys.stderr)


def bounded_process(operation, args, deadline, data=None):
    started = time.monotonic()
    phase = PROCESS_PHASES.get(operation)
    if phase is None:
        print("smoke-http: operation=invalid phase=config error=config outcome=terminal", file=sys.stderr)
        return subprocess.CompletedProcess([], 2, b"", b"")
    for attempt in range(1, 6):
        remaining = deadline - time.monotonic()
        code, category, timed_out = 28, "timeout", False
        diagnostic = b""
        result = subprocess.CompletedProcess(args, code, b"", b"")
        if remaining > 0:
            try:
                runner = ssh_run if phase in {"ssh", "deploy"} else subprocess.run
                result = runner(args, input=data, capture_output=True, timeout=remaining if phase == "deploy" else min(30, remaining))
                code = result.returncode
                if phase == "ssh":
                    relay_diagnostics(result.stderr)
                diagnostic = result.stderr
                category = auth_error(diagnostic) if code else "ok"
            except subprocess.TimeoutExpired as error:
                timed_out = True
                captured = error.stderr or b""
                diagnostic = captured
                if phase == "ssh":
                    relay_diagnostics(captured)
                classified = auth_error(captured)
                category = classified if classified != "unknown" or terminal_diagnostic(captured) else "timeout"
            except OSError:
                code, category = 2, "exec"
                result = subprocess.CompletedProcess(args, code, b"", b"")
        remaining = max(0, deadline - time.monotonic())
        delay = 2 ** (attempt - 1)
        can_retry = phase != "deploy" and category in TRANSIENT and not terminal_diagnostic(diagnostic)
        if phase == "ssh" and code != 255 and not timed_out and category != "iap_not_ready":
            can_retry = False
        outcome = ("deadline" if remaining <= 0 else
                   "recovered" if code == 0 and attempt > 1 else "ok" if code == 0 else
                   "unknown" if category == "unknown" else "terminal" if not can_retry else
                   "exhausted" if attempt == 5 else "deadline" if delay >= remaining else "retry")
        if outcome != "ok":
            print(f"smoke-http: operation={operation} phase={phase} attempt={attempt} exit={code} "
                  f"error={category} elapsed_s={time.monotonic() - started:.3f} "
                  f"remaining_s={remaining:g} delay_s={delay if outcome == 'retry' else 0:g} outcome={outcome}", file=sys.stderr)
        if outcome != "retry":
            return result if outcome in {"ok", "recovered"} else subprocess.CompletedProcess(args, code or 28, b"", category.encode())
        time.sleep(delay)
    return result


def observed_status(status, headers):
    if status != "000":
        return status
    statuses = re.findall(r"(?m)^HTTP/\S+\s+([0-9]{3})\b", headers)
    return statuses[-1] if statuses else "000"


def http_category(code, status, body, stderr=b""):
    category = "http"
    try:
        error = json.loads(body).get("error")
        typed = error.get("status", "") if isinstance(error, dict) else error
        if isinstance(error, dict) and error.get("retryable") is False:
            return "application_terminal", False
        if isinstance(typed, str) and typed.lower() in {
            "permission_denied", "unauthenticated", "invalid_grant", "invalid_target",
            "unauthorized_client", "invalid_request", "resource_exhausted", "unavailable", "deadline_exceeded",
        }:
            category = typed.lower()
            if category not in TRANSIENT:
                return category, False
    except (ValueError, AttributeError, TypeError):
        pass
    if status != "000" and not status.startswith("2") and status not in RETRY_HTTP:
        return category if category != "http" else "http_terminal", False
    if code:
        diagnostic = auth_error(stderr)
        if terminal_diagnostic(stderr):
            return diagnostic, False
        if code in {5, 6, 35} and diagnostic not in TRANSIENT:
            return "unknown", False
        return "transport", code in RETRY_CURL
    return category, status in RETRY_HTTP


def config_request(operation, config, output, deadline):
    if operation not in {"sts", "sts-negative", "impersonate", "read", "fixture-get", "fixture-cas"}:
        print("smoke-http: operation=invalid phase=http error=config outcome=terminal", file=sys.stderr)
        return "000"
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="pi-orb-smoke-federation-") as directory:
        headers = Path(directory) / "headers"
        for attempt in range(1, 6):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print(f"smoke-http: operation={operation} phase=http attempt={attempt} outcome=deadline", file=sys.stderr)
                return "000"
            Path(output).write_bytes(b"")
            headers.write_text("")
            try:
                result = subprocess.run([
                    "curl", "-s", "-K", config, "--connect-timeout", str(min(10, remaining)),
                    "--max-time", str(min(30, remaining)), "--output", output,
                    "--dump-header", str(headers), "--write-out", "%{http_code}",
                ], capture_output=True, timeout=min(30, remaining))
                code = result.returncode
                status = result.stdout.decode(errors="replace").strip()
                if not re.fullmatch(r"[0-9]{3}", status):
                    status = "000"
            except subprocess.TimeoutExpired as error:
                code, status = 28, "000"
                result = subprocess.CompletedProcess([], code, b"", error.stderr or b"")
            except OSError:
                code, status = 2, "000"
            data = Path(output).read_bytes()
            status = observed_status(status, headers.read_text(errors="replace"))
            negative = False
            if operation == "sts-negative" and status == "400":
                try:
                    negative = json.loads(data).get("error") in {"invalid_target", "invalid_grant"}
                except (ValueError, AttributeError, TypeError):
                    pass
            success = code == 0 and (status == "200" or negative)
            category, can_retry = http_category(code, status, data, result.stderr if code != 2 else b"")
            delay = max(2 ** (attempt - 1), retry_after(headers.read_text(errors="replace")))
            remaining = max(0, deadline - time.monotonic())
            outcome = ("deadline" if remaining <= 0 else
                       "recovered" if success and attempt > 1 else "ok" if success else
                       "terminal" if not can_retry else "exhausted" if attempt == 5 else
                       "deadline" if delay >= remaining else "retry")
            if outcome != "ok":
                print(f"smoke-http: operation={operation} phase=http attempt={attempt} exit={code} http={status} "
                      f"error={category} elapsed_s={time.monotonic() - started:.3f} "
                      f"remaining_s={remaining:g} delay_s={delay if outcome == 'retry' else 0:g} outcome={outcome}", file=sys.stderr)
            if outcome != "retry":
                return status if outcome in {"ok", "recovered"} or operation.startswith("fixture-") and code == 0 and outcome != "deadline" else "000"
            time.sleep(delay)
    return "000"


def runtime_refused(origin, token, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        print("smoke-http: operation=runtime-refused phase=http outcome=deadline", file=sys.stderr)
        return 1
    config = b'header = "authorization: Bearer ' + token.strip() + b'"\n'
    code, status, category = 28, "000", "timeout"
    try:
        result = subprocess.run([
            "curl", "-s", "-K", "-", "-X", "POST", origin + "/runtime/v1/tokens/model",
            "-H", "content-type:application/json", "--data", '{"reason":"startup"}',
            "--output", "/dev/null", "--write-out", "%{http_code}",
            "--connect-timeout", str(min(10, remaining)), "--max-time", str(min(30, remaining)),
        ], input=config, capture_output=True, timeout=min(30, remaining))
        code = result.returncode
        status = result.stdout.decode(errors="replace")
        if not re.fullmatch(r"[0-9]{3}", status):
            status = "000"
        category, _ = http_category(code, status, b"", result.stderr)
        success = code == 0 and status == "401" and time.monotonic() < deadline
    except subprocess.TimeoutExpired:
        success = False
    except OSError:
        code, category, success = 2, "exec", False
    print(f"smoke-http: operation=runtime-refused phase=http exit={code} http={status} error={category} outcome=" +
          ("ok" if success else "failed"), file=sys.stderr)
    return 0 if success else 1


def external_main():
    operation, *values = sys.argv[2:]
    deadline = time.monotonic() + min(900 if operation == "stage2-deploy" else 60,
                                      float(os.environ["PI_ORB_SMOKE_DEADLINE"]) - time.time())
    if operation == "runtime-refused":
        origin, = values
        return runtime_refused(origin, sys.stdin.buffer.read(), deadline)
    if operation in {"sts", "sts-negative", "impersonate", "read"}:
        print(config_request(operation, *values, deadline))
        return 0
    if operation in {"tofu-app", "tofu-issuer"}:
        args = ["tofu", "-chdir=" + str(Path(__file__).resolve().parent), "output", "-raw",
                "app_url" if operation == "tofu-app" else "issuer_url"]
        data = None
    elif operation == "stage2-deploy":
        if values:
            return 2
        args = ["bash", "-lc", os.environ["PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND"]]
        data = None
    elif operation == "resource-names":
        kind, name = values
        if kind not in {"instances", "disks"}:
            return 2
        args = ["gcloud", "compute", kind, "list", "--project=" + os.environ["PI_ORB_GCP_PROJECT"],
                "--filter=zone:(" + os.environ["PI_ORB_GCE_ZONE"] + ") AND name=" + name,
                "--format=value(name)"]
        data = None
    elif operation in {"instances-list", "instance-describe", "disk-describe"}:
        name, = values
        args = ["gcloud", "compute", "disks" if operation == "disk-describe" else "instances"]
        if operation == "instances-list":
            args += ["list", "--filter=zone:(" + os.environ["PI_ORB_GCE_ZONE"] +
                     ") AND labels.pi-orb-orb-id=" + name, "--format=value(name)"]
        else:
            args += ["describe", name, "--zone=" + os.environ["PI_ORB_GCE_ZONE"], "--format=json"]
        args += ["--project=" + os.environ["PI_ORB_GCP_PROJECT"]]
        data = None
    elif operation.startswith("ssh-") and operation in PROCESS_PHASES:
        import shlex
        instance, command = values
        args = ["gcloud", "compute", "ssh", instance, "--project=" + os.environ["PI_ORB_GCP_PROJECT"],
                "--zone=" + os.environ["PI_ORB_GCE_ZONE"], "--tunnel-through-iap", "--quiet",
                *shlex.split(os.environ.get("PI_ORB_SMOKE_SSH_FLAGS", "")), "--", command]
        data = sys.stdin.buffer.read()
    else:
        print("smoke-http: operation=invalid phase=config error=config outcome=terminal", file=sys.stderr)
        return 2
    result = bounded_process(operation, args, deadline, data)
    if result.returncode == 0:
        sys.stdout.buffer.write(result.stdout)
    return result.returncode


def main():
    project, origin, path, body, method = sys.argv[1:]
    started = time.monotonic()
    deadline = started + min(
        60, float(os.environ["PI_ORB_SMOKE_DEADLINE"]) - time.time())
    if deadline <= time.monotonic():
        print("smoke-http: phase=auth outcome=deadline", file=sys.stderr)
        return 28
    auth = bounded_process("auth", [
        "gcloud", "auth", "print-identity-token",
        f"--impersonate-service-account=pi-orb-debug@{project}.iam.gserviceaccount.com",
        f"--audiences={origin}",
    ], deadline)
    if auth.returncode:
        return 28 if auth.returncode == 28 else 2
    safe = method in {"GET", "HEAD", "DELETE"} or (method == "POST" and fixed_id_create(path, body))
    args = ["curl", "-s", "-K", "-", "-X", method, origin + path]
    if os.environ.get("PI_ORB_USER_ID"):
        args += ["-H", "X-Pi-Orb-User-Id: " + os.environ["PI_ORB_USER_ID"]]
    if body:
        args += ["-H", "content-type:application/json", "-d", body]
    config = b'header = "Authorization: Bearer ' + auth.stdout.strip() + b'"\n'
    with tempfile.TemporaryDirectory(prefix="pi-orb-smoke-http-") as directory:
        output, headers = Path(directory) / "body", Path(directory) / "headers"
        for attempt in range(1, 6):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print(f"smoke-http: attempt={attempt} outcome=deadline", file=sys.stderr)
                return 28
            output.write_bytes(b"")
            headers.write_text("")
            try:
                response = subprocess.run(
                    [*args, "--connect-timeout", str(min(10, remaining)),
                     "--max-time", str(min(30, remaining)), "--output", str(output),
                     "--dump-header", str(headers), "--write-out", "%{http_code}"],
                    input=config, capture_output=True, timeout=min(30, remaining))
                code = response.returncode
                status = response.stdout.decode(errors="replace").strip()
                if not re.fullmatch(r"[0-9]{3}", status):
                    status = "000"
            except subprocess.TimeoutExpired as error:
                code, status = 28, "000"
                response = subprocess.CompletedProcess([], code, b"", error.stderr or b"")
            except OSError:
                print(f"smoke-http: attempt={attempt} outcome=curl-unavailable", file=sys.stderr)
                return 2
            if time.monotonic() >= deadline:
                print(f"smoke-http: attempt={attempt} outcome=deadline", file=sys.stderr)
                return 28
            data = output.read_bytes()
            metadata = headers.read_text(errors="replace")
            status = observed_status(status, metadata)
            if time.monotonic() >= deadline:
                print(f"smoke-http: operation=application phase=http attempt={attempt} outcome=deadline", file=sys.stderr)
                return 28
            types = re.findall(r"(?im)^content-type:\s*([^\r\n]+)", metadata)
            content_type = types[-1].lower() if types else ""
            kind = ("json" if "json" in content_type else "html" if "html" in content_type
                    else "text" if content_type.startswith("text/") else "other" if content_type else "missing")
            category, _ = http_category(code, status, data, response.stderr if code != 2 else b"")
            edge = (f"smoke-http: operation=application phase=http attempt={attempt} curl={code} "
                    f"http={status} error={category} content_type={kind} elapsed_s={time.monotonic() - started:.3f}")
            if code == 0 and (status.startswith("2") or (status == "404" and method in {"GET", "DELETE"})):
                if attempt > 1:
                    print(f"{edge} outcome=recovered delay_s=0 remaining_s={max(0, deadline - time.monotonic()):g}", file=sys.stderr)
                sys.stdout.buffer.write(data)
                return 0
            terminal_transport = code and not http_category(code, status, data, response.stderr if code != 2 else b"")[1]
            outcome = ("terminal" if terminal_transport or not retryable(code, status, data) else
                       "not-replayed" if not safe else "exhausted" if attempt == 5 else "retry")
            delay = max(2 ** (attempt - 1), retry_after(metadata))
            remaining = max(0, deadline - time.monotonic())
            if outcome == "retry" and delay >= remaining:
                outcome = "deadline"
            print(f"{edge} outcome={outcome} delay_s={delay:g} remaining_s={remaining:g}", file=sys.stderr)
            if outcome != "retry":
                return code or 22
            time.sleep(delay)
    return 22


if __name__ == "__main__":
    try:
        status = external_main() if sys.argv[1:2] == ["external"] else main()
    except (ValueError, KeyError, TypeError):
        print("smoke-http: operation=invalid phase=config error=config outcome=terminal", file=sys.stderr)
        status = 2
    except OSError:
        print("smoke-http: operation=invalid phase=config error=local_io outcome=terminal", file=sys.stderr)
        status = 2
    sys.exit(status)

#!/usr/bin/env python3
"""Bounded HTTP retries for the lifecycle/identity smoke application API."""
import email.utils
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

RETRY_HTTP = {"408", "429", "500", "502", "503", "504"}
RETRY_CURL = {5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92, 95}
UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"


def retryable(code, status, body):
    if code:
        return code in RETRY_CURL
    if status in {"401", "403", "404"}:
        return False
    try:
        error = json.loads(body).get("error")
        if isinstance(error, dict) and isinstance(error.get("retryable"), bool):
            return error["retryable"]
    except (ValueError, AttributeError, UnicodeError):
        pass
    return status in RETRY_HTTP


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


def auth_error(stderr):
    diagnostic = stderr.decode(errors="replace")
    categories = {code.lower() for code in re.findall(
        r"\b(?:PERMISSION_DENIED|UNAUTHENTICATED|RESOURCE_EXHAUSTED|UNAVAILABLE|"
        r"DEADLINE_EXCEEDED|invalid_grant|invalid_target|unauthorized_client)\b",
        diagnostic, re.IGNORECASE)}
    for category, pattern in (
        ("tls", r"\b(?:SSLError|CERTIFICATE_VERIFY_FAILED)\b"),
        ("dns", r"\b(?:NameResolutionError|Temporary failure in name resolution)\b"),
        ("timeout", r"\b(?:ReadTimeout|ConnectTimeout|TimeoutError)\b"),
    ):
        if re.search(pattern, diagnostic, re.IGNORECASE):
            categories.add(category)
    return categories.pop() if len(categories) == 1 else "unknown"


def main():
    project, origin, path, body, method = sys.argv[1:]
    started = time.monotonic()
    deadline = started + min(
        60, float(os.environ["PI_ORB_SMOKE_DEADLINE"]) - time.time())
    if deadline <= time.monotonic():
        print("smoke-http: phase=auth outcome=deadline", file=sys.stderr)
        return 28
    try:
        auth = subprocess.run([
            "gcloud", "auth", "print-identity-token",
            f"--impersonate-service-account=pi-orb-debug@{project}.iam.gserviceaccount.com",
            f"--audiences={origin}",
        ], capture_output=True, timeout=deadline - time.monotonic())
    except (OSError, subprocess.TimeoutExpired) as error:
        category = "timeout" if isinstance(error, subprocess.TimeoutExpired) else "exec"
        print(f"smoke-http: phase=auth outcome=unavailable error={category} "
              f"elapsed_s={time.monotonic() - started:.3f}", file=sys.stderr)
        return 2
    if auth.returncode:
        print(f"smoke-http: phase=auth exit={auth.returncode} outcome=failed "
              f"error={auth_error(auth.stderr)} elapsed_s={time.monotonic() - started:.3f}",
              file=sys.stderr)
        return 2
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
                    input=config, capture_output=True, timeout=remaining)
                code = response.returncode
                status = response.stdout.decode(errors="replace").strip()
                if not re.fullmatch(r"[0-9]{3}", status):
                    status = "000"
            except subprocess.TimeoutExpired:
                code, status = 28, "000"
            except OSError:
                print(f"smoke-http: attempt={attempt} outcome=curl-unavailable", file=sys.stderr)
                return 2
            if time.monotonic() >= deadline:
                print(f"smoke-http: attempt={attempt} outcome=deadline", file=sys.stderr)
                return 28
            data = output.read_bytes()
            metadata = headers.read_text(errors="replace")
            types = re.findall(r"(?im)^content-type:\s*([^\r\n]+)", metadata)
            content_type = types[-1].lower() if types else ""
            kind = ("json" if "json" in content_type else "html" if "html" in content_type
                    else "text" if content_type.startswith("text/") else "other" if content_type else "missing")
            edge = f"smoke-http: attempt={attempt} curl={code} http={status} content_type={kind}"
            if code == 0 and (status.startswith("2") or (status == "404" and method in {"GET", "DELETE"})):
                if attempt > 1:
                    print(f"{edge} outcome=recovered", file=sys.stderr)
                sys.stdout.buffer.write(data)
                return 0
            outcome = ("terminal" if not retryable(code, status, data) else
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
    sys.exit(main())

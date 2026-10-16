#!/usr/bin/env python3
"""Smoke-only curl boundary: bounded, explicitly replay-safe HTTP retries."""
import argparse
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


def retry_after(headers, now):
    values = re.findall(r"(?im)^retry-after:\s*([^\r\n]+)", headers)
    if not values:
        return 0
    value = values[-1].strip()
    if value.isdigit():
        return int(value)
    try:
        return max(0, email.utils.parsedate_to_datetime(value).timestamp() - now)
    except (ValueError, TypeError, OverflowError):
        return 0


def request(policy, args, config, body_file, deadline, clock=time.monotonic,
            sleep=time.sleep, run=subprocess.run, log=sys.stderr, wall=time.time):
    headers_file = body_file.with_suffix(".headers")
    for attempt in range(1, 6):
        remaining = deadline - clock()
        if remaining <= 0:
            print(f"smoke-http: attempt={attempt} outcome=deadline", file=log)
            return 28, "000", b""
        # A new output file per attempt prevents a partial response being reused.
        body_file.write_bytes(b"")
        headers_file.write_text("")
        try:
            response = run(
                ["curl", *args, "--silent", "--connect-timeout", str(min(10, remaining)),
                 "--max-time", str(min(30, remaining)), "--output", str(body_file),
                 "--dump-header", str(headers_file), "--write-out", "%{http_code}\n%{content_type}"],
                input=config, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=remaining,
            )
            code = response.returncode
            metadata = response.stdout.decode("utf-8", errors="replace").split("\n", 1)
            status = metadata[0] if re.fullmatch(r"[0-9]{3}", metadata[0]) else "000"
            content_type = metadata[1].lower() if len(metadata) > 1 else ""
        except subprocess.TimeoutExpired:
            code, status, content_type = 28, "000", ""
        except OSError:
            print(f"smoke-http: attempt={attempt} outcome=curl-unavailable", file=log)
            return 2, "000", b""
        if clock() >= deadline:
            print(f"smoke-http: attempt={attempt} outcome=deadline", file=log)
            return 28, status, b""
        body = body_file.read_bytes()
        kind = ("json" if "json" in content_type else "html" if "html" in content_type
                else "text" if content_type.startswith("text/") else "other" if content_type else "missing")
        edge = f"smoke-http: attempt={attempt} curl={code} http={status} content_type={kind}"
        if code == 0 and status.startswith("2"):
            if attempt > 1:
                print(f"{edge} outcome=recovered", file=log)
            return 0, status, body
        retry = retryable(code, status, body)
        outcome = ("terminal" if not retry else "unsafe-not-replayed" if policy == "once"
                   else "exhausted" if attempt == 5 else "retry")
        delay = max(2 ** (attempt - 1), retry_after(headers_file.read_text(errors="replace"), wall()))
        remaining = max(0, deadline - clock())
        if outcome == "retry" and delay >= remaining:
            outcome = "deadline"
        print(f"{edge} outcome={outcome} delay_s={delay:g} remaining_s={remaining:g}", file=log)
        if outcome != "retry":
            return 75 if outcome == "unsafe-not-replayed" else code or 22, status, body
        sleep(delay)
    return 22, "000", b""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("policy", choices=("safe", "once"))
    parser.add_argument("--status-output", help="write body here; print HTTP status, including terminal 4xx")
    parser.add_argument("--allow-not-found", action="store_true")
    parser.add_argument("curl_args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    args = options.curl_args
    if args[:1] == ["--"]:
        args = args[1:]
    # Convert the caller's wall deadline once; subsequent retry timing is monotonic.
    remaining = min(60, float(os.environ.get("PI_ORB_SMOKE_DEADLINE", time.time() + 60)) - time.time())
    config = sys.stdin.buffer.read() if "-" in args else b""
    with tempfile.TemporaryDirectory(prefix="pi-orb-smoke-http-") as directory:
        code, status, body = request(options.policy, args, config, Path(directory) / "body",
                                     time.monotonic() + remaining)
    if options.status_output:
        Path(options.status_output).write_bytes(body)
        print(status, end="")
        # Negative assertions may examine definitive rejections, never exhausted
        # rate limits/timeouts or transport failures.
        if code == 22 and status.startswith("4") and status not in RETRY_HTTP and not retryable(0, status, body):
            return 0
    elif code == 0 or (options.allow_not_found and code == 22 and status == "404"):
        sys.stdout.buffer.write(body)
    if options.allow_not_found and code == 22 and status == "404":
        return 0
    return code


if __name__ == "__main__":
    sys.exit(main())

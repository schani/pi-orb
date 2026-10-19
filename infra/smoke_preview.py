#!/usr/bin/env python3
"""Bounded HTTP health probe through a userspace Tailscale daemon."""
import email.utils
import http.client
import io
import json
import os
import re
import subprocess
import sys
import time


class ResponseSocket:
    def __init__(self, wire):
        self.wire = wire

    def makefile(self, _mode):
        return io.BytesIO(self.wire)


def terminal_status(wire):
    statuses = re.findall(rb"(?m)^HTTP/\S+\s+([0-9]{3})\b", wire)
    if statuses:
        status = statuses[-1].decode("ascii")
        if not status.startswith("2") and status not in {"408", "429", "500", "502", "503", "504"}:
            return status
    return None


def probe(tailscale, host, timeout=10, metadata=None):
    if len(host) > 253 or not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
        return "000", "config"
    request = (
        f"GET /v1/health HTTP/1.1\r\nHost: {host}:8080\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    # nc exits on stdin EOF, even before a response arrives. The parent owns
    # the writer until nc finishes; parent death also closes it. run() kills
    # and reaps nc on timeout. No proxy listener or background daemon is needed.
    try:
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "rb") as reader, os.fdopen(write_fd, "wb") as writer:
            writer.write(request)
            writer.flush()
            result = subprocess.run(
                [tailscale, "nc", host, "8080"],
                stdin=reader,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
    except subprocess.TimeoutExpired as error:
        status = terminal_status(error.stdout or b"")
        return (status, "http_terminal") if status else ("000", "timeout")
    except OSError:
        return "000", "exec"
    status = terminal_status(result.stdout)
    if status:
        return status, "http_terminal"
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")
        if re.search(r"Permission denied|certificate|invalid auth|not logged in", detail, re.I):
            return "000", "transport_terminal"
        if re.search(r"Connection refused|Connection reset by peer|Temporary failure in name resolution|i/o timeout", detail, re.I):
            return "000", "transport_transient"
        return "000", "unknown"
    try:
        with http.client.HTTPResponse(ResponseSocket(result.stdout)) as response:
            response.begin()
            if metadata is not None:
                metadata["retry_after"] = response.getheader("Retry-After", "")
            return str(response.status), response.read().decode("utf-8")
    except (http.client.HTTPException, ValueError, UnicodeError):
        return "000", "json"


def wait_ready(tailscale, host, budget):
    started = time.monotonic()
    deadline = started + min(25, budget)
    for attempt in range(1, 6):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print(f"smoke-http: operation=preview phase=http attempt={attempt} error=timeout outcome=deadline remaining_s=0", file=sys.stderr)
            return "000", "timeout"
        metadata = {}
        code, body = probe(tailscale, host, min(10, remaining), metadata)
        category, ready = "http_terminal", False
        if code == "200":
            try:
                status = json.loads(body).get("status")
                ready = status == "ready"
                category = "ok" if ready else "not_ready" if status == "starting" else "json"
            except (ValueError, AttributeError):
                category = "json"
        elif code in {"408", "429", "500", "502", "503", "504"}:
            category = "http_transient"
        elif code == "000":
            category = body if body in {"timeout", "transport_transient", "transport_terminal", "exec", "json", "unknown"} else "unknown"
        retry = category in {"timeout", "transport_transient", "http_transient", "not_ready"}
        delay = 2 ** (attempt - 1)
        after = metadata.get("retry_after", "").strip()
        try:
            delay = max(delay, int(after) if after.isdigit() else
                        email.utils.parsedate_to_datetime(after).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            pass
        remaining = max(0, deadline - time.monotonic())
        outcome = ("deadline" if remaining <= 0 else "recovered" if ready and attempt > 1 else
                   "ok" if ready else "terminal" if not retry else "exhausted" if attempt == 5 else
                   "deadline" if delay >= remaining else "retry")
        if outcome != "ok":
            print(f"smoke-http: operation=preview phase=http attempt={attempt} http={code} error={category} "
                  f"elapsed_s={time.monotonic() - started:.3f} remaining_s={remaining:g} "
                  f"delay_s={delay if outcome == 'retry' else 0:g} outcome={outcome}", file=sys.stderr)
        if outcome in {"ok", "recovered"}:
            return "200", '{"status":"ready"}'
        if outcome != "retry":
            return "000", category
        time.sleep(delay)
    return "000", "unknown"


if __name__ == "__main__":
    if len(sys.argv) not in {3, 4}:
        sys.exit("usage: smoke_preview.py <tailscale-cli> <hostname> [readiness-epoch-deadline]")
    code, body = (wait_ready(sys.argv[1], sys.argv[2], max(0, float(sys.argv[3]) - time.time())) if len(sys.argv) == 4
                  else probe(sys.argv[1], sys.argv[2]))
    print(body)
    print(code)
    sys.exit(1 if code == "000" else 0)

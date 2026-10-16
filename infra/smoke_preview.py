#!/usr/bin/env python3
"""Bounded HTTP health probe through a userspace Tailscale daemon."""
import http.client
import io
import os
import re
import signal
import subprocess
import sys
import time


class ResponseSocket:
    def __init__(self, wire):
        self.wire = wire

    def makefile(self, _mode):
        return io.BytesIO(self.wire)


def probe(tailscale, host, timeout=10, *, deadline=None, clock=time.monotonic, wall=time.time):
    timeout = min(timeout, deadline - wall() if deadline is not None else timeout)
    limit = clock() + timeout
    if timeout <= 0:
        return "000", "preview deadline exceeded"
    if len(host) > 253 or not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
        return "000", "invalid preview hostname"
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
                timeout=min(10, timeout),
                check=False,
            )
    except subprocess.TimeoutExpired:
        return "000", f"tailscale nc timed out after {min(10, timeout)}s"
    except OSError:
        return "000", "tailscale nc unavailable"
    if clock() >= limit:
        return "000", "preview deadline exceeded"
    if result.returncode != 0:
        return "000", f"tailscale nc exited {result.returncode}"
    try:
        with http.client.HTTPResponse(ResponseSocket(result.stdout)) as response:
            response.begin()
            return str(response.status), response.read().decode("utf-8")
    except (http.client.HTTPException, ValueError, UnicodeError) as error:
        return "000", f"invalid preview HTTP response: {type(error).__name__}"


def ssh_probe(command, deadline, source, *, clock=time.monotonic, wall=time.time, log=sys.stderr):
    limit = clock() + deadline - wall()
    remaining = limit - clock()
    if remaining <= 0:
        print("peer-preview: ssh outcome=deadline", file=log)
        return b""
    try:
        with subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, start_new_session=True) as process:
            try:
                output, _ = process.communicate(timeout=remaining)
            except subprocess.TimeoutExpired:
                # gcloud owns SSH/IAP children; terminate the whole attempt.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
                print("peer-preview: ssh outcome=deadline", file=log)
                return b""
    except OSError:
        print("peer-preview: ssh outcome=unavailable", file=log)
        return b""
    if clock() >= limit:
        print("peer-preview: ssh outcome=deadline", file=log)
        return b""
    if process.returncode != 0:
        print(f"peer-preview: ssh outcome=failed code={process.returncode}", file=log)
        return b""
    return output


if __name__ == "__main__":
    if len(sys.argv) > 3 and sys.argv[1] == "--ssh":
        response = ssh_probe(sys.argv[3:], float(sys.argv[2]), sys.stdin.buffer)
        sys.stdout.buffer.write(response)
        sys.exit(0 if response else 1)
    if len(sys.argv) not in (3, 4):
        sys.exit("usage: smoke_preview.py <tailscale-cli> <hostname> [wall-deadline]")
    code, body = probe(sys.argv[1], sys.argv[2],
                       deadline=float(sys.argv[3]) if len(sys.argv) == 4 else None)
    print(body)
    print(code)
    sys.exit(1 if code == "000" else 0)

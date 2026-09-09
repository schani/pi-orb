#!/usr/bin/env python3
"""Bounded HTTP health probe through a userspace Tailscale daemon."""
import http.client
import io
import os
import re
import subprocess
import sys


class ResponseSocket:
    def __init__(self, wire):
        self.wire = wire

    def makefile(self, _mode):
        return io.BytesIO(self.wire)


def probe(tailscale, host):
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
                timeout=10,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return "000", "tailscale nc timed out after 10s"
    except OSError as error:
        return "000", f"tailscale nc unavailable: {error}"
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:300]
        return "000", f"tailscale nc exited {result.returncode}: {detail}"
    try:
        with http.client.HTTPResponse(ResponseSocket(result.stdout)) as response:
            response.begin()
            return str(response.status), response.read().decode("utf-8")
    except (http.client.HTTPException, ValueError, UnicodeError) as error:
        return "000", f"invalid preview HTTP response: {type(error).__name__}"


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: smoke_preview.py <tailscale-cli> <hostname>")
    code, body = probe(sys.argv[1], sys.argv[2])
    print(body)
    print(code)
    sys.exit(1 if code == "000" else 0)

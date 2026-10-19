"""Smoke-only fixture publication IO; the publication transaction is single-shot."""
import json
import os
from pathlib import Path
import tempfile
import time

from infra.release_state import Cloud, Result, fail, parse_json
from infra.smoke_http import bounded_process, config_request


class FixtureCloud(Cloud):
    def __init__(self):
        super().__init__()
        self.deadline = time.monotonic() + min(60, float(os.environ.get(
            "PI_ORB_SMOKE_DEADLINE", str(time.time() + 60))) - time.time())

    def http(self, method, url, body=None):
        try:
            token = bounded_process("fixture-auth", ["gcloud", "auth", "print-access-token"], self.deadline)
            if token.returncode:
                category = token.stderr.decode()
                suffix = f" ({category.upper()})" if category in {
                    "permission_denied", "unauthenticated", "resource_exhausted", "unavailable",
                    "deadline_exceeded", "invalid_grant", "invalid_target", "unauthorized_client",
                } else ""
                return fail("command", f"gcloud auth print-access-token exited {token.returncode}{suffix}")
            with tempfile.TemporaryDirectory(prefix="pi-orb-smoke-fixture-") as directory:
                config, output = Path(directory) / "request", Path(directory) / "response"
                fields = {"url": url, "request": method,
                          "header": "Authorization: Bearer " + token.stdout.decode().strip()}
                text = "".join(f"{key} = {json.dumps(value)}\n" for key, value in fields.items())
                if body is not None:
                    text += 'header = "Content-Type: application/json"\n'
                    text += "data = " + json.dumps(json.dumps(body)) + "\n"
                config.touch(mode=0o600)
                config.write_text(text)
                status = config_request("fixture-get" if method == "GET" else "fixture-cas",
                                        str(config), str(output), self.deadline)
                if status == "404":
                    return Result(None)
                if status != "200":
                    return fail("conflict" if status == "412" else "http", f"cloud request HTTP {status}")
                result = parse_json(output.read_bytes())
                return fail("timeout", "fixture IO deadline exceeded") if time.monotonic() >= self.deadline else result
        except OSError:
            return fail("io", "fixture IO unavailable")
        except (UnicodeError, ValueError):
            return fail("invalid", "invalid fixture IO data")

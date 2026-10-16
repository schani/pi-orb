from contextlib import redirect_stdout
import io
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from infra.smoke_http import main, request, retry_after


class Clock:
    def __init__(self):
        self.now = 100
        self.sleeps = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class SmokeHttpTest(unittest.TestCase):
    def run_requests(self, replies, *, policy="safe", deadline=160, duration=0):
        clock = Clock()
        calls = []
        log = io.StringIO()

        def run(args, **kwargs):
            calls.append((args, kwargs))
            clock.now += duration
            code, status, body, content_type = replies[min(len(calls) - 1, len(replies) - 1)]
            Path(args[args.index("--output") + 1]).write_bytes(body)
            return subprocess.CompletedProcess(args, code, f"{status}\n{content_type}".encode(), b"secret stderr")

        with tempfile.TemporaryDirectory() as directory:
            result = request(policy, ["-K", "-", "https://example.invalid/secret-query"], b"secret bearer",
                             Path(directory) / "body", deadline, clock.time, clock.sleep, run, log)
        return result, calls, clock, log.getvalue()

    def test_transient_http_recovers_without_emitting_failed_body_or_secrets(self):
        result, calls, clock, log = self.run_requests([
            (0, "500", b"secret proxy body", "text/html"),
            (0, "200", b'[{"id":"ok"}]', "application/json"),
        ])
        self.assertEqual(result, (0, "200", b'[{"id":"ok"}]'))
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock.sleeps, [1])
        self.assertIn("attempt=1", log)
        self.assertIn("http=500", log)
        self.assertIn("content_type=html", log)
        self.assertIn("outcome=recovered", log)
        for secret in ("secret", "example.invalid", "bearer", "proxy body"):
            self.assertNotIn(secret, log)
        self.assertTrue(all(call[1]["input"] == b"secret bearer" for call in calls))

    def test_retryable_statuses_and_transport(self):
        for code, status in [(0, status) for status in ("408", "429", "500", "502", "503", "504")] + [(code, "000") for code in (5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92, 95)]:
            with self.subTest(code=code, status=status):
                result, calls, _, _ = self.run_requests([
                    (code, status, b"", ""), (0, "200", b"{}", "application/json")
                ])
                self.assertEqual(result[0], 0)
                self.assertEqual(len(calls), 2)

    def test_nonretryable_http_and_transport_fail_immediately(self):
        for code, status in [(0, status) for status in ("400", "401", "403", "404", "409", "422", "501")] + [(code, "000") for code in (2, 3, 23, 26, 60, 77)]:
            with self.subTest(code=code, status=status):
                result, calls, clock, log = self.run_requests([(code, status, b"{}", "application/json")])
                self.assertNotEqual(result[0], 0)
                self.assertEqual(len(calls), 1)
                self.assertFalse(clock.sleeps)
                self.assertIn("outcome=terminal", log)

    def test_explicit_retryability_overrides_status_but_not_auth(self):
        for status, retryable, expected in [("500", False, 1), ("503", False, 1), ("409", True, 2), ("401", True, 1), ("403", True, 1), ("404", True, 1)]:
            with self.subTest(status=status, retryable=retryable):
                _, calls, _, _ = self.run_requests([
                    (0, status, json.dumps({"error": {"retryable": retryable}}).encode(), "application/json"),
                    (0, "200", b"{}", "application/json"),
                ])
                self.assertEqual(len(calls), expected)

    def test_unsafe_mutation_is_not_replayed(self):
        result, calls, clock, log = self.run_requests([(28, "000", b"", "")], policy="once")
        self.assertEqual(result[0], 75)
        self.assertEqual(len(calls), 1)
        self.assertFalse(clock.sleeps)
        self.assertIn("outcome=unsafe-not-replayed", log)

    def test_negative_assertion_only_receives_definitive_nontransient_4xx(self):
        for status, body, expected in [
            ("400", b'{"error":"invalid_target"}', 0),
            ("429", b'{"error":{"retryable":false}}', 22),
            ("409", b'{"error":{"retryable":true}}', 22),
            ("503", b'{"error":{"retryable":false}}', 22),
        ]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                output = str(Path(directory) / "body")
                with patch("sys.argv", ["smoke_http.py", "--status-output", output, "safe", "--", "https://invalid"]), \
                     patch("infra.smoke_http.request", return_value=(22, status, body)), \
                     redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), expected)

    def test_allow_not_found_requires_completed_terminal_response(self):
        cases = [
            ("completed", [(0, "404", b"missing", "text/plain")], 160, 0, 0),
            ("curl-timeout", [(28, "404", b"partial", "text/plain")], 160, 0, 28),
            ("deadline", [(0, "404", b"missing", "text/plain")], 102, 3, 28),
        ]
        for name, replies, deadline, duration, expected in cases:
            result, _, _, _ = self.run_requests(replies, deadline=deadline, duration=duration)
            with self.subTest(case=name):
                stdout = io.TextIOWrapper(io.BytesIO())
                with patch("sys.argv", ["smoke_http.py", "--allow-not-found", "safe", "--", "https://invalid"]), \
                     patch("infra.smoke_http.request", return_value=result), \
                     redirect_stdout(stdout):
                    self.assertEqual(main(), expected)
                    stdout.flush()
                    self.assertEqual(stdout.buffer.getvalue(), result[2] if expected == 0 else b"")

    def test_retry_logs_numeric_delay_and_remaining_budget(self):
        _, _, _, log = self.run_requests([
            (0, "503", b"secret", "text/html"), (0, "200", b"{}", "application/json")
        ], deadline=105, duration=1)
        self.assertRegex(log, r"delay_s=1(?:\.0+)? remaining_s=4(?:\.0+)?")

    def test_exhaustion_is_bounded(self):
        result, calls, clock, log = self.run_requests([(0, "503", b"{}", "application/json")])
        self.assertEqual(result[0], 22)
        self.assertEqual(len(calls), 5)
        self.assertEqual(clock.sleeps, [1, 2, 4, 8])
        self.assertIn("outcome=exhausted", log)

    def test_step_budget_caps_attempt_and_backoff(self):
        result, calls, clock, log = self.run_requests([(0, "503", b"{}", "application/json")], deadline=102, duration=1)
        self.assertNotEqual(result[0], 0)
        self.assertLessEqual(clock.now, 102)
        self.assertEqual(len(calls), 1)
        self.assertEqual(float(calls[0][0][calls[0][0].index("--max-time") + 1]), 2)
        self.assertIn("outcome=deadline", log)

    def test_late_success_cannot_escape_step_deadline(self):
        result, calls, clock, log = self.run_requests(
            [(0, "200", b"{}", "application/json")], deadline=102, duration=3)
        self.assertNotEqual(result[0], 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("outcome=deadline", log)

    def test_expired_budget_does_no_io(self):
        result, calls, clock, log = self.run_requests([(0, "200", b"{}", "")], deadline=100)
        self.assertNotEqual(result[0], 0)
        self.assertEqual(calls, [])
        self.assertEqual(clock.sleeps, [])
        self.assertIn("outcome=deadline", log)

    def test_ambiguous_commands_observe_without_replaying_or_hiding_failed_boot(self):
        root = Path(__file__).parent
        for script in ("smoke.sh", "smoke-workload-identity.sh"):
            source = (root / script).read_text()
            command = re.search(r"^command_orb\(\).*?^}", source, re.M | re.S).group()
            for verb, state, status, expected, calls in [
                ("start", "starting", 75, 0, 2), ("start", "running", 75, 0, 2),
                ("stop", "stopping", 75, 0, 2), ("stop", "stopped", 75, 0, 2),
                ("start", "failed", 75, 1, 2), ("start", "stopped", 75, 1, 2),
                ("stop", "failed", 75, 1, 2), ("start", "running", 22, 1, 1),
            ]:
                with self.subTest(script=script, verb=verb, state=state, status=status):
                    with tempfile.TemporaryDirectory() as directory:
                        log = Path(directory) / "calls"
                        result = subprocess.run(["bash", "-c", f"""
set -euo pipefail
ORB_ID=orb
say() {{ :; }}
fail() {{ exit 1; }}
jget() {{ jq -r '.error.code // empty'; }}
api() {{
  echo "$*" >> '{log}'
  if [ "$(wc -l < '{log}')" -eq 1 ]; then return {status}; fi
  echo '{{"state":"{state}"}}'
}}
{command}
command_orb {'orb ' if script != 'smoke.sh' else ''}{verb}
"""], capture_output=True, text=True, check=False)
                        self.assertEqual(result.returncode, expected, result.stderr)
                        lines = log.read_text().splitlines()
                        self.assertEqual(len(lines), calls)
                        self.assertEqual(sum(f"/{verb}" in line for line in lines), 1)

    def test_retry_after_seconds_date_and_invalid(self):
        self.assertEqual(retry_after("HTTP/1.1 429\r\nRetry-After: 9\r\n", 100), 9)
        self.assertEqual(retry_after("Retry-After: Thu, 01 Jan 1970 00:02:00 GMT\r\n", 100), 20)
        self.assertEqual(retry_after("Retry-After: garbage\r\n", 100), 0)

    def test_smoke_consumers_use_shared_boundary_and_nearest_deadline(self):
        root = Path(__file__).parent
        for script in ("smoke.sh", "smoke-workload-identity.sh"):
            source = (root / script).read_text()
            self.assertIn('export PI_ORB_SMOKE_HTTP=1', source)
            self.assertIn('PI_ORB_SMOKE_DEADLINE="$limit" api', source)
        fixtures = (root / "smoke-fixtures.sh").read_text()
        self.assertIn('PI_ORB_SMOKE_DEADLINE="$deadline"', fixtures)
        replacement = (root / "smoke-compute-replacement.sh").read_text()
        self.assertIn("smoke_http.py", replacement)
        self.assertNotIn("curl -fsS", replacement)
        identity = (root / "smoke-workload-identity.sh").read_text()
        self.assertNotIn("status=$(curl", identity)
        self.assertIn("smoke-fetch.cjs", identity)
        self.assertNotRegex(identity, r'(?m)^preview=.+\$limit', "preview must not use a function-local deadline")

    def test_api_opt_in_keeps_404_cleanup_and_bearer_private(self):
        root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "gcloud").write_text("#!/bin/sh\necho called >> \"$AUTH_LOG\"\nprintf secret-bearer")
            (folder / "curl").write_text("""#!/usr/bin/env python3
import pathlib, sys
args = sys.argv[1:]
if "--output" not in args:
    sys.exit(99)
config = sys.stdin.buffer.read()
assert b"secret-bearer" in config
assert not any("secret-bearer" in arg for arg in args)
pathlib.Path(args[args.index("--output") + 1]).write_text('{"error":{"code":"not_found"}}')
print("404\\napplication/json", end="")
""")
            for command in ("curl", "gcloud"):
                (folder / command).chmod(0o755)
            result = subprocess.run(
                ["bash", str(root / "api.sh"), "/api/v1/orbs/missing"],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "PI_ORB_APP_ORIGIN": "https://example.invalid", "PI_ORB_SMOKE_HTTP": "1",
                     "PI_ORB_SMOKE_DEADLINE": "4102444800", "PI_ORB_USER_ID": "",
                     "AUTH_LOG": str(folder / "auth-log")},
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"error": {"code": "not_found"}})
            self.assertNotIn("secret", result.stderr)
            auth_log = (folder / "auth-log").read_text()
            expired = subprocess.run(
                ["bash", str(root / "api.sh"), "/api/v1/orbs/missing"],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "PI_ORB_APP_ORIGIN": "https://example.invalid", "PI_ORB_SMOKE_HTTP": "1",
                     "PI_ORB_SMOKE_DEADLINE": "0", "AUTH_LOG": str(folder / "auth-log")},
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(expired.returncode, 0)
            self.assertEqual((folder / "auth-log").read_text(), auth_log)


    def test_successful_arrays_and_empty_bodies_remain_valid(self):
        for status, body in [("200", b"[]"), ("204", b"")]:
            result, calls, _, log = self.run_requests([(0, status, body, "application/json")])
            self.assertEqual(result, (0, status, body))
            self.assertEqual(len(calls), 1)
            self.assertEqual(log, "")


if __name__ == "__main__":
    unittest.main()

import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from infra import smoke_http

ID = "00000000-0000-4000-8000-000000000001"


class SmokeHttpTest(unittest.TestCase):
    def invoke(self, replies, path="/api/v1/orbs/" + ID, body="", method="GET",
               budget=60, auth_duration=0, duration=0, auth_code=0):
        now, calls, sleeps = [100.0], [], []
        output, log = io.TextIOWrapper(io.BytesIO()), io.StringIO()

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "gcloud":
                now[0] += auth_duration
                return subprocess.CompletedProcess(args, auth_code, b"secret-token", b"secret-auth")
            now[0] += duration
            index = sum(call[0][0] == "curl" for call in calls) - 1
            reply = replies[min(index, len(replies) - 1)]
            if isinstance(reply, Exception):
                raise reply
            code, status, response, headers = reply
            Path(args[args.index("--output") + 1]).write_bytes(response)
            Path(args[args.index("--dump-header") + 1]).write_text(headers)
            return subprocess.CompletedProcess(args, code, status.encode(), b"secret-transport")

        with patch.dict(os.environ, {"PI_ORB_SMOKE_DEADLINE": str(100 + budget),
                                     "PI_ORB_USER_ID": ID}), \
             patch("sys.argv", ["smoke_http.py", "project", "https://private.invalid", path, body, method]), \
             patch.object(smoke_http.time, "time", return_value=100), \
             patch.object(smoke_http.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(smoke_http.time, "sleep", side_effect=sleep), \
             patch.object(smoke_http.subprocess, "run", side_effect=run), \
             patch("sys.stdout", output), patch("sys.stderr", log):
            code = smoke_http.main()
        output.flush()
        return code, output.buffer.getvalue(), calls, sleeps, log.getvalue()

    def test_proxy500_recovers_with_private_diagnostics_and_auth(self):
        code, body, calls, sleeps, log = self.invoke([
            (0, "500", b"secret-proxy-body", "Content-Type: text/html\r\n"),
            (0, "200", b'[{"id":"ok"}]', "Content-Type: application/json\r\n"),
        ])
        self.assertEqual((code, body, sleeps), (0, b'[{"id":"ok"}]', [1]))
        self.assertEqual([call[0][0] for call in calls], ["gcloud", "curl", "curl"])
        for args, kwargs in calls[1:]:
            self.assertNotIn("secret-token", " ".join(args))
            self.assertIn(b"secret-token", kwargs["input"])
            self.assertIn("X-Pi-Orb-User-Id: " + ID, args)
        for expected in ("attempt=1", "http=500", "content_type=html", "outcome=retry",
                         "outcome=recovered", "delay_s=1", "remaining_s=60"):
            self.assertIn(expected, log)
        for secret in ("secret", "private.invalid", ID):
            self.assertNotIn(secret, log)

    def test_retry_allowlists(self):
        for code, status in ([(0, str(s)) for s in (408, 429, 500, 502, 503, 504)] +
                             [(c, "000") for c in (5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 92, 95)]):
            with self.subTest(code=code, status=status):
                result = self.invoke([(code, status, b"", ""), (0, "204", b"", "")])
                self.assertEqual((result[0], result[1], len(result[2])), (0, b"", 3))

    def test_permanent_failures_and_typed_override(self):
        cases = ([(0, str(s), b"{}") for s in (400, 401, 403, 409, 422, 501)] +
                 [(c, "000", b"") for c in (2, 3, 23, 26, 60, 77)] +
                 [(0, "500", b'{"error":{"retryable":false}}'),
                  (0, "503", b'{"error":{"retryable":false}}'),
                  (0, "401", b'{"error":{"retryable":true}}'),
                  (0, "403", b'{"error":{"retryable":true}}')])
        for code, status, body in cases:
            with self.subTest(code=code, status=status, body=body):
                result = self.invoke([(code, status, body, "")])
                self.assertNotEqual(result[0], 0)
                self.assertEqual((result[1], len(result[2]), result[3]), (b"", 2, []))
        result = self.invoke([(0, "409", b'{"error":{"retryable":true}}', ""),
                              (0, "200", b"{}", "")])
        self.assertEqual((result[0], len(result[2])), (0, 3))

    def test_only_fixed_id_creates_are_replayed(self):
        for path, body, expected in [
            ("/api/v1/projects", json.dumps({"id": ID}), 0),
            (f"/api/v1/projects/{ID}/orbs", json.dumps({"id": ID}), 0),
            (f"/api/v1/orbs/{ID}/start", "{}", 22),
            (f"/api/v1/orbs/{ID}/stop", "{}", 22),
            ("/api/v1/projects", "{}", 22),
            ("/api/v1/projects", '{"id":"not-a-uuid"}', 22),
            ("/api/v1/other", json.dumps({"id": ID}), 22),
        ]:
            for transport, status in [(0, "503"), (28, "000")]:
                with self.subTest(path=path, body=body, transport=transport):
                    result = self.invoke([(transport, status, b"secret", ""), (0, "200", b"{}", "")],
                                         path=path, body=body, method="POST")
                    self.assertEqual((result[0], len(result[2])),
                                     (0 if expected == 0 else transport or 22, 3 if expected == 0 else 2))
                    if expected == 0:
                        self.assertEqual(result[2][1][0], result[2][2][0])

    def test_only_completed_404_satisfies_cleanup(self):
        missing = b'{"error":{"code":"not_found"}}'
        for transport, duration, expected in [(0, 0, 0), (28, 0, 28), (0, 61, 28)]:
            for method in ("GET", "DELETE"):
                with self.subTest(transport=transport, duration=duration, method=method):
                    result = self.invoke([(transport, "404", missing, "")], duration=duration, method=method)
                    self.assertEqual(result[0], expected)
                    self.assertEqual(result[1], missing if expected == 0 else b"")
                    self.assertEqual(len(result[2]), 6 if transport else 2)

    def test_deadline_includes_auth_attempts_and_backoff(self):
        for budget, auth_duration, duration, count, expected in [
            (0, 0, 0, 0, 28), (5, 5, 0, 1, 28), (5, 3, 1, 2, 22),
            (5, 0, 6, 2, 28),
        ]:
            with self.subTest(budget=budget, auth=auth_duration, duration=duration):
                result = self.invoke([(0, "200" if duration == 6 else "503", b"", "")], budget=budget,
                                     auth_duration=auth_duration, duration=duration)
                self.assertEqual((result[0], len(result[2]), result[3]), (expected, count, []))
                self.assertIn("outcome=deadline", result[4])
        result = self.invoke([(0, "200", b"{}", "")], budget=5, auth_duration=3)
        self.assertEqual(result[0], 0)
        args, kwargs = result[2][-1]
        self.assertEqual(float(args[args.index("--max-time") + 1]), 2)
        self.assertEqual(kwargs["timeout"], 2)

    def test_auth_failure_and_timeout_are_private(self):
        result = self.invoke([], auth_code=1)
        self.assertNotEqual(result[0], 0)
        self.assertEqual(len(result[2]), 1)
        self.assertNotIn("secret", result[4])
        with patch.object(smoke_http.subprocess, "run", side_effect=subprocess.TimeoutExpired("gcloud", 1)), \
             patch.dict(os.environ, {"PI_ORB_SMOKE_DEADLINE": "4102444800"}):
            with patch("sys.argv", ["smoke_http.py", "project", "https://private.invalid", "/api/v1/projects", "", "GET"]), \
                 patch("sys.stderr", io.StringIO()) as log:
                self.assertNotEqual(smoke_http.main(), 0)
                self.assertNotIn("private", log.getvalue())

    def test_transport_exceptions_are_bounded(self):
        result = self.invoke([subprocess.TimeoutExpired("curl", 1)])
        self.assertEqual((result[0], len(result[2])), (28, 6))
        result = self.invoke([OSError("secret")])
        self.assertEqual((result[0], len(result[2])), (2, 2))
        self.assertNotIn("secret", result[4])

    def test_exhaustion_and_retry_after_stay_bounded(self):
        result = self.invoke([(0, "503", b"secret", "")])
        self.assertEqual((result[0], len(result[2]), result[3]), (22, 6, [1, 2, 4, 8]))
        self.assertIn("outcome=exhausted", result[4])
        for header, delay in [("Retry-After: 9", 9),
                              ("Retry-After: Thu, 01 Jan 1970 00:02:00 GMT", 20),
                              ("Retry-After: garbage", 1)]:
            result = self.invoke([(0, "429", b"", header), (0, "200", b"{}", "")])
            self.assertEqual((result[0], result[3]), (0, [delay]))
        result = self.invoke([(0, "429", b"", "Retry-After: 60")])
        self.assertEqual((result[0], len(result[2]), result[3]), (22, 2, []))
        self.assertIn("outcome=deadline", result[4])


if __name__ == "__main__":
    unittest.main()

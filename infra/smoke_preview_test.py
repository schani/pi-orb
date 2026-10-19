import io
import os
import subprocess
import unittest
from unittest.mock import patch

from infra.smoke_preview import probe


class PreviewProbeTest(unittest.TestCase):
    def run_response(self, wire, returncode=0, stderr=b""):
        def run(command, *, stdin, stdout, stderr, timeout, check):
            self.assertEqual(command, ["tailscale-test", "nc", "orb.example.ts.net", "8080"])
            self.assertEqual(timeout, 10)
            self.assertFalse(check)
            self.assertEqual(stdout, subprocess.PIPE)
            self.assertEqual(stderr, subprocess.PIPE)
            expected = (
                b"GET /v1/health HTTP/1.1\r\nHost: orb.example.ts.net:8080\r\n"
                b"Connection: close\r\n\r\n"
            )
            self.assertEqual(stdin.read(len(expected)), expected)
            os.set_blocking(stdin.fileno(), False)
            self.assertIsNone(stdin.read(1), "stdin must remain open, not return EOF")
            return result

        result = subprocess.CompletedProcess([], returncode, wire, stderr)
        with patch("infra.smoke_preview.subprocess.run", side_effect=run):
            return probe("tailscale-test", "orb.example.ts.net")

    def test_content_length_and_stdin_ownership(self):
        self.assertEqual(
            self.run_response(b'HTTP/1.1 200 OK\r\nContent-Length: 18\r\n\r\n{"status":"ready"}'),
            ("200", '{"status":"ready"}'),
        )

    def test_chunked_response(self):
        self.assertEqual(
            self.run_response(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n12\r\n{"status":"ready"}\r\n0\r\n\r\n'),
            ("200", '{"status":"ready"}'),
        )

    def test_non_200_is_not_hidden(self):
        self.assertEqual(self.run_response(b"HTTP/1.0 503 Unavailable\r\n\r\nstarting"), ("503", "starting"))

    def test_empty_and_truncated_http_are_failures(self):
        for wire in (b"", b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort"):
            code, body = self.run_response(wire)
            self.assertEqual(code, "000")
            self.assertEqual(body, "json")

    def test_process_failure_is_visible(self):
        self.assertEqual(self.run_response(b"", 1, b"dial refused"), ("000", "unknown"))

    def test_timeout_and_spawn_failure(self):
        for error, message in (
            (subprocess.TimeoutExpired("tailscale", 10), "timeout"),
            (FileNotFoundError("missing CLI"), "exec"),
        ):
            with patch("infra.smoke_preview.subprocess.run", side_effect=error):
                code, body = probe("tailscale-test", "orb.example.ts.net")
            self.assertEqual(code, "000")
            self.assertIn(message, body)

    def test_header_injection_refused_before_spawn(self):
        with patch("infra.smoke_preview.subprocess.run") as run:
            for host in ("host\r\nInjected: yes", "a" * 254):
                self.assertEqual(probe("tailscale-test", host), ("000", "config"))
            run.assert_not_called()

class PreviewReadinessTest(unittest.TestCase):
    def invoke(self, replies, budget=25):
        import io
        from infra import smoke_preview
        now, calls, sleeps = [0.0], [], []
        def attempt(*args):
            calls.append(args)
            reply = replies[min(len(calls) - 1, len(replies) - 1)]
            if len(reply) == 3:
                args[3]["retry_after"] = reply[2]
            return reply[:2]
        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        with patch.object(smoke_preview, "probe", side_effect=attempt), \
             patch.object(smoke_preview.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(smoke_preview.time, "sleep", side_effect=sleep), \
             patch("sys.stderr", io.StringIO()) as log:
            result = smoke_preview.wait_ready("tailscale", "host", budget)
        self.assertNotIn("secret", log.getvalue())
        return result, calls, sleeps, log.getvalue()

    def test_transient_and_expected_not_ready_recover(self):
        for reply in [("503", "secret"), ("000", "transport_transient"), ("200", '{"status":"starting"}')]:
            result, calls, sleeps, log = self.invoke([reply, ("200", '{"status":"ready"}')])
            self.assertEqual(result, ("200", '{"status":"ready"}'))
            self.assertEqual((len(calls), sleeps), (2, [1]))
            self.assertIn("outcome=recovered", log)

    def test_assertion_json_unknown_and_credentials_are_terminal(self):
        for reply in [("200", "secret-not-json"), ("200", '{"status":"broken"}'), ("401", "secret"),
                      ("000", "unknown"), ("000", "transport_terminal"), ("000", "json")]:
            result, calls, sleeps, log = self.invoke([reply])
            self.assertEqual(result[0], "000")
            self.assertEqual((len(calls), sleeps), (1, []))
            self.assertIn("outcome=terminal", log)

    def test_exhaustion_and_deadline(self):
        result, calls, sleeps, log = self.invoke([("503", "secret")])
        self.assertEqual((len(calls), sleeps), (5, [1, 2, 4, 8]))
        self.assertIn("outcome=exhausted", log)
        result, calls, sleeps, log = self.invoke([("503", "secret")], budget=1)
        self.assertEqual((len(calls), sleeps), (1, []))
        self.assertIn("outcome=deadline", log)


class PreviewRetryAfterTest(unittest.TestCase):
    invoke = PreviewReadinessTest.invoke
    def test_retry_after_shares_preview_budget(self):
        result, calls, sleeps, log = self.invoke([("429", "secret", "9"), ("200", '{"status":"ready"}')])
        self.assertEqual((result[0], len(calls), sleeps), ("200", 2, [9]))
        result, calls, sleeps, log = self.invoke([("503", "secret", "60")])
        self.assertEqual((result[0], len(calls), sleeps), ("000", 1, []))
        self.assertIn("outcome=deadline", log)

class PreviewPartialHeadersTest(unittest.TestCase):
    def test_terminal_partial_headers_override_timeout_and_reset(self):
        from infra import smoke_preview
        for status in ('403', '404', '422'):
            wire = f'HTTP/1.1 {status} Refused\r\nContent-Length: 999\r\n\r\nsecret'.encode()
            for reply in (subprocess.TimeoutExpired('secret', 10, output=wire, stderr=b'secret'),
                          subprocess.CompletedProcess([], 1, wire, b'Connection reset by peer secret')):
                with self.subTest(status=status, reply=type(reply).__name__), \
                     patch.object(smoke_preview.subprocess, 'run', side_effect=reply if isinstance(reply, Exception) else lambda *a, **kw: reply) as run, \
                     patch.object(smoke_preview.time, 'sleep') as sleep, \
                     patch('sys.stderr', io.StringIO()) as log:
                    result = smoke_preview.wait_ready('tailscale', 'host', 25)
                    self.assertEqual(result[0], '000')
                    self.assertEqual(run.call_count, 1)
                    sleep.assert_not_called()
                    self.assertIn('outcome=terminal', log.getvalue())
                    self.assertNotIn('secret', log.getvalue())


if __name__ == "__main__":
    unittest.main()

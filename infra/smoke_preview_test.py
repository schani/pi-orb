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
            self.assertIn("invalid preview HTTP response", body)

    def test_process_failure_is_visible(self):
        self.assertEqual(self.run_response(b"", 1, b"dial refused"), ("000", "tailscale nc exited 1: dial refused"))

    def test_timeout_and_spawn_failure(self):
        for error, message in (
            (subprocess.TimeoutExpired("tailscale", 10), "timed out after 10s"),
            (FileNotFoundError("missing CLI"), "unavailable"),
        ):
            with patch("infra.smoke_preview.subprocess.run", side_effect=error):
                code, body = probe("tailscale-test", "orb.example.ts.net")
            self.assertEqual(code, "000")
            self.assertIn(message, body)

    def test_header_injection_refused_before_spawn(self):
        with patch("infra.smoke_preview.subprocess.run") as run:
            for host in ("host\r\nInjected: yes", "a" * 254):
                self.assertEqual(probe("tailscale-test", host), ("000", "invalid preview hostname"))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

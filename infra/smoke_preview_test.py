import io
import os
import signal
from pathlib import Path
import tempfile
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
        self.assertEqual(self.run_response(b"", 1, b"dial refused"), ("000", "tailscale nc exited 1"))

    def test_timeout_and_spawn_failure(self):
        for error, message in (
            (subprocess.TimeoutExpired("tailscale", 10), "timed out after 10s"),
            (FileNotFoundError("missing CLI"), "unavailable"),
        ):
            with patch("infra.smoke_preview.subprocess.run", side_effect=error):
                code, body = probe("tailscale-test", "orb.example.ts.net")
            self.assertEqual(code, "000")
            self.assertIn(message, body)

    def test_nearest_deadline_caps_the_remote_probe(self):
        def run(*args, **kwargs):
            self.assertEqual(kwargs["timeout"], 2)
            return subprocess.CompletedProcess([], 0, b"HTTP/1.0 503 Busy\r\n\r\nstarting")
        with patch("infra.smoke_preview.subprocess.run", side_effect=run):
            self.assertEqual(probe("tailscale-test", "orb.example.ts.net", 2), ("503", "starting"))

    def test_remote_absolute_deadline_includes_ssh_delay_and_rejects_late_200(self):
        for wall, duration, calls in [(102, 0, 0), (101, 2, 1)]:
            now = [50]
            def run(*args, **kwargs):
                self.assertEqual(kwargs["timeout"], 1)
                now[0] += duration
                return subprocess.CompletedProcess([], 0, b'HTTP/1.0 200 OK\r\n\r\n{"status":"ready"}')
            with patch("infra.smoke_preview.subprocess.run", side_effect=run) as transport:
                code, body = probe("tailscale-test", "orb.example.ts.net", deadline=102,
                                   clock=lambda: now[0], wall=lambda: wall)
            self.assertEqual(code, "000")
            self.assertIn("deadline", body)
            self.assertEqual(transport.call_count, calls)

    def test_ssh_is_bounded_and_late_success_is_rejected(self):
        from infra.smoke_preview import ssh_probe
        for wall, duration, calls in [(102, 0, 0), (101, 2, 1), (101, 0, 1)]:
            now = [50]
            def communicate(*, timeout):
                self.assertEqual(timeout, 1)
                now[0] += duration
                return b'{"status":"ready"}\n200\n', b"secret stderr"
            log = io.StringIO()
            with patch("infra.smoke_preview.subprocess.Popen") as transport:
                process = transport.return_value.__enter__.return_value
                process.communicate.side_effect = communicate
                process.returncode = 0
                result = ssh_probe(["gcloud", "compute", "ssh"], 102, None,
                                   clock=lambda: now[0], wall=lambda: wall, log=log)
                self.assertEqual(transport.call_count, calls)
                if calls:
                    transport.assert_called_once_with(["gcloud", "compute", "ssh"], stdin=None,
                                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                      start_new_session=True)
            self.assertEqual(result, b'{"status":"ready"}\n200\n' if duration == 0 and calls else b"")
            self.assertNotIn("ready", log.getvalue())
            self.assertNotIn("secret", log.getvalue())

    def test_ssh_timeout_kills_owned_process_group(self):
        from infra.smoke_preview import ssh_probe
        with patch("infra.smoke_preview.subprocess.Popen") as spawn, \
             patch("infra.smoke_preview.os.killpg") as kill:
            process = spawn.return_value.__enter__.return_value
            process.pid = 321
            process.communicate.side_effect = [subprocess.TimeoutExpired("ssh", 1), (b"", b"secret")]
            log = io.StringIO()
            self.assertEqual(ssh_probe(["gcloud"], 102, None, clock=lambda: 50,
                                      wall=lambda: 101, log=log), b"")
            kill.assert_called_once_with(321, signal.SIGKILL)
            self.assertEqual(process.communicate.call_count, 2)
            self.assertNotIn("secret", log.getvalue())

    def test_shell_rejects_success_after_preview_deadline(self):
        source = Path(__file__).with_name("smoke-workload-identity.sh").read_text()
        loop = source[source.index("preview_deadline="):source.index("\nmint() {")]
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(["bash", "-c", f"""
set -euo pipefail
DEADLINE=1000
DIR='{Path(__file__).parent.resolve()}'
WORK_DIR='{directory}'
MINT_INSTANCE=instance
preview=orb.example.ts.net
now_file='{directory}/clock'
echo 100 > "$now_file"
date() {{ cat "$now_file"; }}
check_deadline() {{ :; }}
fail() {{ echo "$*" >&2; exit 1; }}
say() {{ echo "$*"; }}
orb_ssh() {{ echo 161 > "$now_file"; printf '%s\\n' '{{"status":"ready"}}' 200; }}
smoke_sleep() {{ exit 2; }}
{loop}
"""], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("peer-preview", result.stderr)
        self.assertNotIn("peer preview health", result.stdout)

    def test_header_injection_refused_before_spawn(self):
        with patch("infra.smoke_preview.subprocess.run") as run:
            for host in ("host\r\nInjected: yes", "a" * 254):
                self.assertEqual(probe("tailscale-test", host), ("000", "invalid preview hostname"))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

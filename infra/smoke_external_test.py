import io
import subprocess
import unittest
from unittest.mock import patch

from infra import smoke_http


class ExternalSmokeTest(unittest.TestCase):
    def invoke(self, replies, operation="instances-list", budget=60, duration=0):
        now, calls, sleeps = [0.0], [], []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            now[0] += duration
            reply = replies[min(len(calls) - 1, len(replies) - 1)]
            if isinstance(reply, Exception):
                raise reply
            return subprocess.CompletedProcess(args, *reply)
        def sleep(delay):
            sleeps.append(delay)
            now[0] += delay
        with patch.object(smoke_http.subprocess, "run", side_effect=run), \
             patch.object(smoke_http, "ssh_run", side_effect=run, create=True), \
             patch.object(smoke_http.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(smoke_http.time, "sleep", side_effect=sleep), \
             patch("sys.stderr", io.StringIO()) as log:
            result = smoke_http.bounded_process(operation, ["gcloud", "secret-arg"], budget,
                                                data=b"secret-stdin")
        self.assertNotIn("secret", log.getvalue())
        return result, calls, sleeps, log.getvalue()

    def test_transient_recovery_and_timeout_cap(self):
        for marker in (b"UNAVAILABLE", b"RESOURCE_EXHAUSTED", b"DEADLINE_EXCEEDED",
                       b"Temporary failure in name resolution", b"ConnectionResetError"):
            with self.subTest(marker=marker):
                result, calls, sleeps, log = self.invoke([(1, b"secret", marker), (0, b"ok", b"")])
                self.assertEqual((result.returncode, result.stdout, sleeps), (0, b"ok", [1]))
                self.assertEqual(len(calls), 2)
                self.assertEqual([c[1]["timeout"] for c in calls], [30, 30])
                self.assertIn("outcome=recovered", log)
                for field in ("operation=instances-list", "phase=cloud", "attempt=1", "elapsed_s=", "remaining_s=", "error=", "exit=1"):
                    self.assertIn(field, log)

    def test_terminal_unknown_and_precedence(self):
        for marker in (b"PERMISSION_DENIED UNAVAILABLE", b"invalid_grant ReadTimeout", b"CERTIFICATE_VERIFY_FAILED ConnectionResetError",
                       b"Name or service not known", b"NameResolutionError", b"secret", b"SSLError"):
            with self.subTest(marker=marker):
                result, calls, sleeps, log = self.invoke([(1, b"secret", marker)])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((len(calls), sleeps), (1, []))
                self.assertNotIn("outcome=retry", log)

    def test_exhaustion_and_shared_deadline(self):
        result, calls, sleeps, log = self.invoke([(1, b"secret", b"UNAVAILABLE")])
        self.assertEqual((len(calls), sleeps), (5, [1, 2, 4, 8]))
        self.assertIn("outcome=exhausted", log)
        result, calls, sleeps, log = self.invoke([(1, b"", b"ReadTimeout")], budget=3, duration=2)
        self.assertEqual((len(calls), sleeps), (1, []))
        self.assertIn("outcome=deadline", log)
        result, calls, sleeps, log = self.invoke([(0, b"secret", b"")], budget=2, duration=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outcome=deadline", log)
        result, calls, sleeps, log = self.invoke([(0, b"", b"")], budget=0)
        self.assertEqual(len(calls), 0)

    def test_ssh_classification_never_retries_remote_cli_failure(self):
        for code, stderr, attempts in [
            (255, b"Connection refused", 2),
            (1, b"Error while connecting [4003: failed to connect to backend]", 2),
            (255, b"REMOTE HOST IDENTIFICATION HAS CHANGED Connection reset", 1),
            (255, b"Permission denied (publickey) Connection reset", 1),
            (1, b"PERMISSION_DENIED UNAVAILABLE", 1),
            (255, b"secret", 1),
            (6, b"UNAVAILABLE Connection reset", 1),
            (1, b"Connection reset", 1),
            (28, b"ReadTimeout secret", 1),
        ]:
            with self.subTest(code=code, stderr=stderr):
                result, calls, _, _ = self.invoke([(code, b"secret", stderr), (0, b"ok", b"")], operation="ssh-mint")
                self.assertEqual(len(calls), attempts)
                self.assertEqual(calls[0][1]["input"], b"secret-stdin")

    def test_unknown_operation_is_local_terminal(self):
        result, calls, _, log = self.invoke([(0, b"", b"")], operation="arbitrary-command")
        self.assertEqual((result.returncode, len(calls)), (2, 0))
        self.assertIn("error=config", log)

    def test_exception_privacy_and_retry_policy(self):
        for error, count in [(OSError("secret"), 1), (subprocess.TimeoutExpired("secret", 30, stderr=b"secret"), 5)]:
            result, calls, _, log = self.invoke([error])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(calls), count)
            self.assertNotIn("secret", log)

class FederationHttpTest(unittest.TestCase):
    def invoke(self, replies, operation="sts", budget=60):
        import tempfile
        from pathlib import Path
        now, calls, sleeps = [0.0], [], []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            code, status, body, headers = replies[min(len(calls) - 1, len(replies) - 1)]
            Path(args[args.index("--output") + 1]).write_bytes(body)
            Path(args[args.index("--dump-header") + 1]).write_text(headers)
            return subprocess.CompletedProcess(args, code, status.encode(), b"secret-stderr")
        def sleep(delay):
            sleeps.append(delay)
            now[0] += delay
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(smoke_http.subprocess, "run", side_effect=run), \
             patch.object(smoke_http.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(smoke_http.time, "sleep", side_effect=sleep), \
             patch("sys.stderr", io.StringIO()) as log:
            output = Path(directory) / "body"
            result = smoke_http.config_request(operation, "secret-config", str(output), budget)
            data = output.read_bytes() if output.exists() else b""
        self.assertNotIn("secret", log.getvalue())
        return result, data, calls, sleeps, log.getvalue()

    def test_all_federation_calls_recover_without_token_in_argv(self):
        for operation in ("sts", "sts-negative", "impersonate", "read"):
            with self.subTest(operation=operation):
                result, data, calls, sleeps, log = self.invoke([(0, "429", b"secret", "Retry-After: 9"), (0, "200", b"{}", "")], operation)
                self.assertEqual((result, data, sleeps), ("200", b"{}", [9]))
                self.assertEqual(len(calls), 2)
                self.assertIn("--max-time", calls[0][0])
                self.assertIn("outcome=recovered", log)

    def test_wrong_audience_requires_typed_rejection_not_a_transient_status(self):
        for status, body, expected in [("400", b'{"error":"invalid_target"}', "400"),
                                       ("400", b'{"error":"invalid_grant"}', "400"),
                                       ("403", b'{"error":"permission_denied"}', "000"),
                                       ("400", b"secret-invalid-json", "000"),
                                       ("408", b"secret", "000"), ("429", b"secret", "000")]:
            with self.subTest(status=status, body=body):
                result, _, calls, _, log = self.invoke([(0, status, body, "")], "sts-negative")
                self.assertEqual(result, expected)
                self.assertEqual(len(calls), 5 if status in {"408", "429"} else 1)

    def test_terminal_transport_and_deadline(self):
        for code in (60, 77, 2, 3):
            result, _, calls, sleeps, log = self.invoke([(code, "000", b"secret", "")])
            self.assertEqual((result, len(calls), sleeps), ("000", 1, []))
        result, _, calls, sleeps, log = self.invoke([(0, "429", b"secret", "Retry-After: 60")])
        self.assertEqual((result, len(calls), sleeps), ("000", 1, []))
        self.assertIn("outcome=deadline", log)

class SshOwnershipTest(unittest.TestCase):
    def test_timeout_kills_owned_group_and_joins_before_return(self):
        from unittest.mock import Mock
        process = Mock(pid=123, returncode=-9)
        process.communicate.side_effect = [subprocess.TimeoutExpired("secret", 1), (b"", b"")]
        with patch.object(smoke_http.subprocess, "Popen", return_value=process) as spawn, \
             patch.object(smoke_http.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                smoke_http.ssh_run(["gcloud", "secret"], input=b"secret-token", capture_output=True, timeout=1)
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])
        kill.assert_called_once_with(123, smoke_http.signal.SIGKILL)
        self.assertEqual(process.communicate.call_count, 2)
        self.assertEqual(process.communicate.call_args.kwargs["timeout"], 2)

    def test_only_allowlisted_remote_diagnostics_survive(self):
        diagnostic = (b'identity-mint: {"event":"result","attempt":2,"elapsedMs":10,"outcome":"retryable","message":"secret-token"}\n'
                      b'identity-mint: {"event":"secret","attempt":1}\n'
                      b'identity-mint: {"event":"retry","attempt":2,"elapsedMs":12,"waitMs":250}\n'
                      b'smoke-http: operation=probe phase=http attempt=1 http=503 error=http_transient elapsed_s=0 remaining_s=60 delay_s=1 outcome=retry\n'
                      b'smoke-http: operation=secret phase=http error=secret outcome=retry\nsecret-stderr\n')
        with patch("sys.stderr", io.StringIO()) as log:
            smoke_http.relay_diagnostics(diagnostic)
        self.assertNotIn("secret", log.getvalue())
        self.assertIn('"outcome":"retryable"', log.getvalue())
        self.assertIn('"waitMs":250', log.getvalue())
        self.assertIn('operation=probe', log.getvalue())

class CleanupDiagnosticsTest(unittest.TestCase):
    def test_fixture_failures_distinguish_delete_confirm_and_record(self):
        from pathlib import Path
        helpers = Path('infra/smoke-fixtures.sh').read_text()
        for phase in ('delete', 'confirm', 'record'):
            with self.subTest(phase=phase):
                confirm = 'return 1' if phase == 'confirm' else '''printf '%s' '{"error":{"code":"not_found"}}' '''
                script = f'''set -eu
{helpers}
api() {{
  if [ "${{3:-}}" = DELETE ]; then
    {'return 1' if phase == 'delete' else "printf '%s' '{}'"}
  else
    {confirm}
  fi
}}
fixture_record() {{ {'return 1' if phase == 'record' else 'return 0'}; }}
API=api
fixture_delete orb owned-id
'''
                result = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'phase={phase}', result.stderr)
                self.assertNotIn('secret', result.stderr)

class FederationClassificationTest(unittest.TestCase):
    invoke = FederationHttpTest.invoke
    def test_terminal_oauth_and_google_codes_override_transient_http(self):
        for body, category in [(b'{"error":"invalid_grant","error_description":"secret"}', 'invalid_grant'),
                               (b'{"error":{"status":"PERMISSION_DENIED","message":"secret"}}', 'permission_denied')]:
            result, _, calls, sleeps, log = self.invoke([(0, "503", body, "")])
            self.assertEqual((result, len(calls), sleeps), ("000", 1, []))
            self.assertIn(f'error={category}', log)

class TerminalResponseTest(unittest.TestCase):
    invoke = FederationHttpTest.invoke

    def test_terminal_headers_dominate_body_transport_failures(self):
        for status in ('400', '401', '403', '404', '422', '501'):
            for transport in (18, 28, 56):
                with self.subTest(status=status, transport=transport):
                    result, _, calls, sleeps, _ = self.invoke([(transport, status, b'secret', '')])
                    self.assertEqual((result, len(calls), sleeps), ('000', 1, []))
                    self.assertFalse(smoke_http.retryable(transport, status, b'secret'))

    def test_unknown_dns_proxy_and_tls_errors_fail_closed(self):
        for transport in (5, 6, 35):
            result, _, calls, sleeps, log = self.invoke([(transport, '000', b'secret', '')])
            self.assertEqual((result, len(calls), sleeps), ('000', 1, []))

    def test_partial_terminal_diagnostics_override_timeout(self):
        helper = ExternalSmokeTest()
        for operation, diagnostic in [('auth', b'PERMISSION_DENIED secret'), ('ssh-mint', b'Host key verification failed secret')]:
            error = subprocess.TimeoutExpired('secret', 30, stderr=diagnostic)
            result, calls, sleeps, log = helper.invoke([error], operation=operation)
            self.assertEqual((len(calls), sleeps), (1, []))
            self.assertNotIn('outcome=retry', log)

class MixedTerminalTest(unittest.TestCase):
    def test_terminal_body_overrides_transport(self):
        for body in (b'{"error":{"retryable":false}}', b'{"error":{"status":"PERMISSION_DENIED"}}'):
            for code in (18, 28, 56):
                self.assertFalse(smoke_http.retryable(code, '503', body))
                self.assertFalse(smoke_http.http_category(code, '503', body)[1])

    def test_conflicting_terminal_diagnostics_remain_terminal_after_timeout(self):
        diagnostic = b'PERMISSION_DENIED invalid_grant secret'
        result, calls, sleeps, log = ExternalSmokeTest().invoke([subprocess.TimeoutExpired('secret', 30, stderr=diagnostic)])
        self.assertEqual((len(calls), sleeps), (1, []))
        self.assertIn('error=unknown', log)
        self.assertFalse(smoke_http.http_category(28, '000', b'', diagnostic)[1])

    def test_oauth_category_survives_terminal_status(self):
        self.assertEqual(smoke_http.http_category(0, '400', b'{"error":"invalid_target"}'), ('invalid_target', False))


if __name__ == "__main__":
    unittest.main()

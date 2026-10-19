import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


class FixtureIoTest(unittest.TestCase):
    def invoke(self, replies, actions, budget=60, duration=0):
        from infra import smoke_http
        from infra.smoke_fixture import FixtureCloud
        now, calls, sleeps = [0.0], [], []
        def run(args, **kwargs):
            reply = replies[len(calls)]
            now[0] += duration
            if args[0] == 'gcloud':
                calls.append(('auth', args, kwargs))
                return subprocess.CompletedProcess(args, reply[0], b'secret-token', reply[1])
            config = Path(args[args.index('-K') + 1])
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            content = config.read_text()
            self.assertIn('secret-token', content)
            self.assertNotIn('secret-token', ' '.join(args))
            calls.append(('http', content, kwargs))
            code, status, body = reply
            Path(args[args.index('--output') + 1]).write_bytes(body)
            return subprocess.CompletedProcess(args, code, status.encode(), b'secret-stderr')
        def sleep(delay):
            sleeps.append(delay)
            now[0] += delay
        with patch.object(smoke_http.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(smoke_http.time, 'time', return_value=100), \
             patch.object(smoke_http.time, 'sleep', side_effect=sleep), \
             patch.object(smoke_http.subprocess, 'run', side_effect=run), \
             patch.dict(os.environ, {'PI_ORB_SMOKE_DEADLINE': str(100 + budget)}), \
             patch('sys.stderr', io.StringIO()) as log:
            cloud = FixtureCloud()
            results = [action(cloud) for action in actions]
        self.assertNotIn('secret', log.getvalue())
        return results, calls, sleeps, log.getvalue()

    def test_auth_and_get_recover_with_one_publication_deadline(self):
        results, calls, sleeps, log = self.invoke([
            (1, b'UNAVAILABLE secret'), (0, b''), (0, '503', b'secret'), (0, '200', b'{"generation":"7"}'),
            (0, b''), (0, '200', b'{"fixtures":[]}'),
        ], [lambda cloud: cloud.object('bucket', 'record')])
        self.assertIsNone(results[0].error)
        self.assertEqual(results[0].value['generation'], '7')
        self.assertEqual(sleeps, [1, 1])
        self.assertIn('ifGenerationMatch=7', calls[-1][1])
        self.assertEqual(calls[2][1], calls[3][1])

    def test_lost_cas_ack_retries_identical_generation_and_body_then_stops_on_412(self):
        results, calls, sleeps, log = self.invoke([
            (0, b''), (28, '000', b''), (0, '412', b'secret'),
        ], [lambda cloud: cloud.put('bucket', 'record', {'fixtures': []}, '7')])
        self.assertEqual(results[0].error.kind, 'conflict')
        self.assertEqual((len(calls), sleeps), (3, [1]))
        self.assertEqual(calls[1][1], calls[2][1])
        self.assertIn('ifGenerationMatch=7', calls[1][1])
        self.assertNotIn('outcome=recovered', log)

    def test_terminal_auth_preserves_existing_result_diagnostic(self):
        results, calls, sleeps, _ = self.invoke([(7, b'PERMISSION_DENIED secret')], [lambda cloud: cloud.object('bucket', 'record')])
        self.assertEqual(results[0].error.message, 'gcloud auth print-access-token exited 7 (PERMISSION_DENIED)')
        self.assertEqual((len(calls), sleeps), (1, []))

    def test_invalid_json_never_retries_and_shared_budget_never_resets(self):
        results, calls, sleeps, _ = self.invoke([(0, b''), (0, '200', b'secret-invalid-json')], [lambda cloud: cloud.object('bucket', 'record')])
        self.assertEqual(results[0].error.kind, 'invalid')
        self.assertEqual(len(calls), 2)
        results, calls, sleeps, log = self.invoke([(1, b'UNAVAILABLE'), (0, b'')],
            [lambda cloud: cloud.object('bucket', 'record'), lambda cloud: cloud.object('bucket', 'record')], budget=2, duration=1)
        self.assertTrue(all(result.error for result in results))
        self.assertEqual((len(calls), sleeps), (2, []))
        self.assertIn('outcome=deadline', log)

    def test_completed_io_after_deadline_cannot_publish_success(self):
        results, calls, sleeps, log = self.invoke([(0, b''), (0, '200', b'{"generation":"7"}')],
            [lambda cloud: cloud.put('bucket', 'record', {'fixtures': []}, '7')], budget=2, duration=1.1)
        self.assertIsNotNone(results[0].error)
        self.assertIn('outcome=deadline', log)

    def test_platform_faults_return_private_results_without_replay(self):
        from infra import smoke_fixture
        faults = [('tempfile.TemporaryDirectory', OSError('secret-path')),
                  ('Path.touch', OSError('secret-path')),
                  ('Path.write_text', ValueError('secret-config')),
                  ('config_request', OSError('secret-request')),
                  ('Path.read_bytes', OSError('secret-response'))]
        for target, fault in faults:
            with self.subTest(target=target), \
                 patch.object(smoke_fixture, 'bounded_process', return_value=subprocess.CompletedProcess([], 0, b'secret-token', b'')) as auth, \
                 patch.object(smoke_fixture, 'config_request', return_value='200'), \
                 patch('infra.smoke_fixture.' + target, side_effect=fault) as failed, \
                 patch('sys.stderr', io.StringIO()) as log:
                result = smoke_fixture.FixtureCloud().http('GET', 'https://storage.googleapis.com/secret')
                self.assertIsNotNone(result.error)
                self.assertNotIn('secret', result.error.message)
                self.assertNotIn('secret', log.getvalue())
                self.assertEqual((auth.call_count, failed.call_count), (1, 1))
        with patch.object(smoke_fixture, 'bounded_process', return_value=subprocess.CompletedProcess([], 0, b'\xffsecret-token', b'')) as auth:
            result = smoke_fixture.FixtureCloud().http('GET', 'https://storage.googleapis.com/secret')
            self.assertIsNotNone(result.error)
            self.assertNotIn('secret', result.error.message)
            self.assertEqual(auth.call_count, 1)


if __name__ == "__main__":
    unittest.main()

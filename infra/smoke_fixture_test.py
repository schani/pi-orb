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


class ReplacementBoundaryTest(unittest.TestCase):
    def shell(self, script, data=""):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(["bash", "-euc", 'source infra/smoke-fixtures.sh\n' + script],
                input=data, capture_output=True, text=True, timeout=5,
                env={**os.environ, "ROOT": directory, "PI_ORB_USER_ID": "selected-user"})
        return result

    def test_private_summaries_use_raw_stdin_and_fresh_files(self):
        raw = {"name": "instance", "id": "17", "disks": [{"boot": True, "source": "boot", "secret": "secret"}],
               "metadata": {"items": [{"key": "pi-orb-host-spec-fingerprint", "value": "spec"},
                   {"key": "pi-orb-config", "value": "secret" + "x" * 65536}]}, "unrelated": "secret", "status": "READY", "sizeGb": "10"}
        result = self.shell('''umask 022
mkdir "$ROOT/evidence"
printf untouched > "$ROOT/sentinel"
ln -s "$ROOT/sentinel" "$ROOT/evidence/old-instance.json"
replacement_evidence_dir "$ROOT/evidence"
[[ -p /dev/stdin ]]
raw=$(cat)
printf '%s' "$raw" | instance_summary > "$log_dir/instance.json"
printf '%s' "$raw" | disk_summary > "$log_dir/disk.json"
printf '%s' '{"id":"orb","state":"failed","token":"secret"}' | orb_summary > "$log_dir/orb.json"
python3 -c 'import os, sys; print(*(oct(os.stat(p).st_mode & 0o777)[2:] for p in sys.argv[1:]), sep="\\n")' "$log_dir" "$log_dir/instance.json" "$log_dir/orb.json" "$log_dir/disk.json"
cat "$ROOT/sentinel"; echo
jq -c . "$log_dir/instance.json" "$log_dir/orb.json" "$log_dir/disk.json"
''', json.dumps(raw))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[:5], ["700", "600", "600", "600", "untouched"])
        self.assertNotIn("secret", result.stdout + result.stderr)
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()[5:]], [
            {"name": "instance", "id": "17", "disks": [{"boot": True, "source": "boot"}], "spec": "spec"},
            {"id": "orb", "state": "failed"},
            {"name": "instance", "id": "17", "status": "READY", "sizeGb": "10"}])

    def test_both_ids_require_typed_absence_before_claim_or_mutation(self):
        for user, reply, transport, missing in [("selected-user", '{"error":{"code":"not_found"}}', 0, True),
            ("selected-user", '{"id":"existing"}', 0, False), ("selected-user", '{}', 0, False),
            ("selected-user", 'invalid', 0, False), ("selected-user", '{"error":{"code":"permission_denied"}}', 0, False),
            ("selected-user", '{"error":{"code":"not_found"}}', 7, False), ("", '{}', 0, False)]:
            for occupied in ("project", "orb"):
                with self.subTest(user=user, reply=reply, transport=transport, occupied=occupied):
                    result = self.shell(f'''PI_ORB_USER_ID='{user}'
project_id=project; orb_id=orb; boot_deadline_seconds=60
project_pending=0; orb_pending=0
trap 'echo "pending:$project_pending:$orb_pending"' EXIT
api() {{ echo "request:$*" >&2; if [[ "$1" == */{occupied} ]]; then printf '%s' '{reply}'; return {transport}; fi; printf '%s' '{{"error":{{"code":"not_found"}}}}'; }}
API=api
replacement_preflight
echo mutation
''')
                    self.assertEqual(result.returncode == 0, missing, result.stderr)
                    self.assertEqual("mutation" in result.stdout, missing)
                    self.assertIn("pending:0:0", result.stdout)
                    self.assertNotIn("POST", result.stderr)
                    self.assertNotIn("DELETE", result.stderr)
                    if not user: self.assertNotIn("request:", result.stderr)
                    elif missing: self.assertEqual(result.stderr.count("request:"), 2)

    def test_record_precedes_create_and_failed_creates_remain_owned(self):
        for record, response, code, created in [(0, '{"id":"orb"}', 0, True),
            (1, '{"id":"orb"}', 0, False), (0, '{"id":"other"}', 0, False),
            (0, '{"error":{"code":"denied"}}', 0, False), (0, '{"id":"orb"}', 7, False)]:
            with self.subTest(record=record, response=response, code=code):
                result = self.shell(f'''replacement_evidence_dir "$ROOT"
orb_pending=0
fixture_record() {{ echo "record:$3" >&2; return {record}; }}
api() {{ grep -q '"outcome":"requested"' "$log_dir/fixtures.jsonl"; echo POST >&2; printf '%s' '{response}'; return {code}; }}
trap 'echo "pending:$orb_pending"; cat "$log_dir/fixtures.jsonl"' EXIT
replacement_create orb orb /api/v1/projects/project/orbs '{{"id":"orb"}}'
''')
                self.assertEqual(result.returncode == 0, created, result.stderr)
                self.assertIn("pending:1", result.stdout)
                self.assertEqual("POST" in result.stderr, record == 0)
                if record == 0: self.assertLess(result.stderr.index("record:requested"), result.stderr.index("POST"))
                self.assertEqual('"outcome":"created"' in result.stdout, created)

    def test_delete_requires_completed_typed_absence(self):
        for body, transport, accepted in [('{"error":{"code":"not_found"}}', 0, True),
            ('{"id":"orb"}', 0, False), ('{}', 0, False), ('invalid', 0, False),
            ('{"error":{"code":"permission_denied"}}', 0, False),
            ('{"error":{"code":"not_found"}}', 7, False)]:
            with self.subTest(body=body, transport=transport):
                result = self.shell(f'''DEADLINE=0
api() {{ printf '%s' '{body}'; return {transport}; }}
API=api
fixture_record() {{ :; }}
fixture_delete orb orb
''')
                self.assertEqual(result.returncode == 0, accepted, result.stderr)

    def test_provider_absence_requires_success_for_every_owned_disk(self):
        for code, names, accepted in [(0, "", True), (0, "present", False), (7, "", False)]:
            with self.subTest(code=code, names=names):
                absent = self.shell(f'''resource_names() {{ printf '%s' '{names}'; return {code}; }}
instance_absent old-instance
''')
                self.assertEqual(absent.returncode == 0, accepted, absent.stderr)
        for failed in ("", "instances", "data", "boot", "instances-present", "data-present", "boot-present"):
            with self.subTest(failed=failed):
                result = self.shell(f'''data_disk=data; boot_disks=(boot); dispose_deadline_seconds=0
instances() {{ echo instances >&2; [[ '{failed}' != instances-present ]] || echo present; [[ '{failed}' != instances ]]; }}
resource_names() {{ echo "$*" >&2; [[ "$2-present" != '{failed}' ]] || echo present; [[ "$2" != '{failed}' ]]; }}
verify_provider_cleanup
''')
                self.assertEqual(result.returncode == 0, failed == "", result.stderr)
                if not failed: self.assertEqual(result.stderr.splitlines(), ["instances", "disks data", "disks boot"])

    def test_cleanup_retains_failures_and_stops_after_unconfirmed_deletion(self):
        for status, project, orb, provider in [(1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0),
                                              (0, 2, 0, 0), (0, 0, 2, 0), (0, 0, 0, 1), (0, 0, 0, 0)]:
            with self.subTest(status=status, project=project, orb=orb, provider=provider):
                result = self.shell(f'''replacement_evidence_dir "$ROOT"
project_id=project; orb_id=orb; project_pending=1; orb_pending=1
fixture_delete() {{ echo "delete:$1" >&2; if [[ "$1" == project ]]; then return {project}; else return {orb}; fi; }}
fixture_record() {{ :; }}
verify_provider_cleanup() {{ echo provider >&2; return {provider}; }}
dump_failure() {{ cat "$log_dir/fixtures.jsonl" >&2; }}
trap on_exit EXIT
exit {status}
''')
                passed = not (status or project or orb or provider)
                self.assertEqual(result.returncode == 0, passed, result.stderr)
                self.assertEqual("smoke passed" in result.stdout, passed)
                self.assertEqual("delete:project" in result.stderr, status == 0)
                self.assertEqual("delete:orb" in result.stderr, status == 0 and project == 0)
                self.assertEqual('"kind":"project","id":"project","outcome":"retained"' in result.stderr,
                                 not passed and (status != 0 or project == 1))


if __name__ == "__main__":
    unittest.main()

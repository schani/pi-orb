"""Offline preflight output and environment contract; no installs or guest calls."""
import contextlib
import hashlib
import io
import json
import os
import pathlib
import runpy
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('preflight-owned-context.py')
ORB = '9675b61b-f1e9-404a-84d3-ad79e18cea61'
SENTINEL = 'SECRET_PROVIDER_STACK_PRIVATE_CONTEXT'


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = pathlib.Path(self.temp.name) / 'source.tgz'
        data = b'{}'
        name = 'package.json'
        with tarfile.open(self.archive, 'w:gz') as archive:
            for path, value in [(name, data), ('owned-context-manifest.json', json.dumps({name: hashlib.sha256(data).hexdigest()}).encode())]:
                member = tarfile.TarInfo(path)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def execute(self, driver_output, returncode=1, graph_returncode=0):
        calls = []
        class Result:
            def __init__(self, code, stdout=b''):
                self.returncode = code
                self.stdout = stdout
        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if args[:2] == ['node', '--experimental-strip-types'] and args[2].endswith('owned-context.ts'):
                return Result(returncode, driver_output)
            if args[:2] == ['npm', 'ls']:
                return Result(graph_returncode)
            return Result(0)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', [str(SCRIPT), str(self.archive), self.sha, ORB]), patch.dict(os.environ, {'NODE_PATH': SENTINEL, 'NODE_OPTIONS': SENTINEL, 'DEBUG': SENTINEL, 'NODE_DEBUG': SENTINEL}), patch('subprocess.run', fake_run), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as exit_result:
                runpy.run_path(str(SCRIPT), run_name='__main__')
                raise SystemExit(0)
        text = out.getvalue() + err.getvalue() + str(exit_result.exception)
        self.assertNotIn(SENTINEL, text)
        self.assertIn('npm', calls[0][0])
        self.assertEqual(calls[1][0], ['npm', 'ls', '--all', '--omit=dev'])
        for _, kwargs in calls:
            for key in ('NODE_PATH', 'NODE_OPTIONS', 'DEBUG', 'NODE_DEBUG'):
                self.assertNotIn(key, kwargs['env'])
        return text, exit_result.exception, calls

    def test_known_failed_stage_is_recovered_without_extra_fields(self):
        text, status, _ = self.execute(json.dumps({'status': 'inference_unavailable', 'profile': 'root', 'error': SENTINEL}).encode())
        self.assertIn('"validationStage":"failure_schema"', text)
        self.assertIn('"driverStatus":"inference_unavailable"', text)
        self.assertNotEqual(status.code, 0)
        text, status, _ = self.execute(b'{"status":"inference_unavailable","profile":"root"}')
        self.assertIn('"status":"inference_unavailable"', text)
        self.assertIn('"profile":"root"', text)
        self.assertNotEqual(status.code, 0)

    def test_workspace_write_failure_emits_sanitized_baseline_diagnostic(self):
        # writeWorkerProfile catches a rejected baseline workspace write before any profile starts.
        value = {'status': 'workspace_unavailable',
                 'diagnostic': {'stage': 'baseline_prompt', 'profiles': []}}
        text, status, _ = self.execute(json.dumps(value).encode())
        self.assertEqual(status.code, 1)
        self.assertEqual(json.loads(text.splitlines()[1]), value)
        for mutation in [
            {'stage': SENTINEL},
            {'profiles': [{'prompt': SENTINEL}]},
        ]:
            with self.subTest(mutation=mutation):
                bad = {'status': 'workspace_unavailable',
                       'diagnostic': dict(value['diagnostic'], **mutation)}
                text, status, _ = self.execute(json.dumps(bad).encode())
                self.assertEqual(status.code, 1)
                self.assertNotIn(SENTINEL, text)
                self.assertEqual(json.loads(text.splitlines()[1])['validationStage'], 'failure_schema')

    def test_every_driver_diagnostic_failure_variant(self):
        # Each status below is emitted by failed(status, stage) in owned-context.ts.
        cases = [
            ('workspace_unavailable', 'baseline_prompt'),
            ('extension_unavailable', 'root_prompt'),
            ('session_unavailable', 'baseline_prompt'),
            ('binding_unavailable', 'root_prompt'),
            ('executor_unavailable', 'baseline_prompt'),
            ('inference_unavailable', 'root_prompt'),
            ('discovery_unavailable', 'root_discovery'),
            ('baseline_not_empty', 'baseline_discovery'),
            ('search_unavailable', 'root_search_prompt'),
            ('measurement_unavailable', 'root_after_search'),
            ('child_service_unavailable', 'root_child'),
            ('child_spawn_unavailable', 'baseline_child'),
            ('child_unavailable', 'root_child'),
            ('denied_calls', 'root_gate'),
        ]
        for status_name, stage in cases:
            with self.subTest(status=status_name):
                value = {'status': status_name, 'diagnostic': {'stage': stage, 'profiles': []}}
                text, status, _ = self.execute(json.dumps(value).encode())
                self.assertIn('"status":"' + status_name + '"', text)
                self.assertIn('"stage":"' + stage + '"', text)
                self.assertNotIn('validationStage', text)
                self.assertEqual(status.code, 1)

    def test_sanitized_search_failure_diagnostics(self):
        diagnostic = {'stage': 'root_search_prompt', 'profiles': [{'profile': 'root',
            'searched': {'cloudflare account': 1, 'datadog monitor': 0},
            'deniedCalls': 1, 'deniedCategories': {'tool_search': 1, 'codemode': 0, 'other': 0},
            'deniedSearchShape': {'queryMatchesPolicy': True, 'queryObserved': True,
                'hasLimit': True, 'onlyQueryAndLimit': True, 'limitValid': True},
            'completed': False, 'modelVerified': True,
            'discovered': {'cloudflare': 3, 'datadog': 33}, 'metrics': []}]}
        value = {'status': 'search_unavailable', 'diagnostic': diagnostic}
        text, status, _ = self.execute(json.dumps(value).encode())
        self.assertIn('root_search_prompt', text)
        self.assertNotEqual(status.code, 0)
        for mutation in [
            {'stage': SENTINEL},
            {'profiles': [dict(diagnostic['profiles'][0], rawContext=SENTINEL)]},
            {'profiles': [dict(diagnostic['profiles'][0], deniedCategories={'tool_search': 0, 'codemode': 0, 'other': 0, SENTINEL: 1})]},
            {'profiles': [dict(diagnostic['profiles'][0], searched={'cloudflare account': 1, SENTINEL: 1})]},
            {'profiles': [dict(diagnostic['profiles'][0], metrics=[{'prompt': SENTINEL}])]},
            {'profiles': [dict(diagnostic['profiles'][0], deniedSearchShape=dict(diagnostic['profiles'][0]['deniedSearchShape'], rawInput=SENTINEL))]},
            {'profiles': [dict(diagnostic['profiles'][0], deniedSearchShape={'queryMatchesPolicy': SENTINEL})]},
        ]:
            with self.subTest(mutation=mutation):
                bad = {'status': 'search_unavailable', 'diagnostic': dict(diagnostic, **mutation)}
                text, status, _ = self.execute(json.dumps(bad).encode())
                self.assertIn('"validationStage":"failure_schema"', text)
                self.assertNotIn(SENTINEL, text)
                self.assertNotEqual(status.code, 0)

    def test_rejects_unknown_status_profile_and_non_object(self):
        for value in [b'{"status":"new_stage"}', b'{"status":"inference_unavailable","profile":"private"}', b'{"status":"model_unavailable","profile":"root"}', b'[]', b'not json', b'{"status":"unavailable"}' + SENTINEL.encode(), b' ' * 30001]:
            with self.subTest(value=value[:50]):
                text, status, _ = self.execute(value)
                self.assertIn('"validationStage":', text)
                self.assertNotEqual(status.code, 0)

    def test_schema_rejection_has_only_safe_validation_metadata(self):
        cases = [
            (b'{"status":"child_unavailable","diagnostic":{"stage":"root_child","profiles":[{"prompt":"' + SENTINEL.encode() + b'"}]}}', 'failure_schema', 'child_unavailable', 7),
            (b'{"status":"' + SENTINEL.encode() + b'","secret":"' + SENTINEL.encode() + b'"}', 'failure_schema', 'unknown', 1),
            (b'{"status":"measured","report":[{"raw":"' + SENTINEL.encode() + b'"}]}', 'success_schema', 'measured', 0),
            (b'{"status":"search_unavailable","extra":"' + SENTINEL.encode() + b'"}', 'failure_schema', 'search_unavailable', 1),
            (b'not json ' + SENTINEL.encode(), 'json_decode', 'unknown', 1),
            (b' ' * 30001 + SENTINEL.encode(), 'size_limit', 'unknown', 1),
        ]
        for raw, stage, driver_status, code in cases:
            with self.subTest(stage=stage, driver_status=driver_status):
                text, status, _ = self.execute(raw, returncode=code)
                self.assertNotIn(SENTINEL, text)
                self.assertEqual(status.code, 1)
                output = json.loads(text.splitlines()[1])
                self.assertEqual(output, {'validationStage': stage, 'driverExitCode': code, 'driverStatus': driver_status})

    def test_private_tokens_never_escape_rejected_fields(self):
        for status_name in [SENTINEL, SENTINEL * 100, 'child_unavailable']:
            for field in ['prompt', 'rawOutput', 'stack', 'stderr']:
                with self.subTest(status=status_name[:30], field=field):
                    value = {'status': status_name, 'diagnostic': {'stage': 'root_child', 'profiles': []},
                             field: SENTINEL}
                    text, status, _ = self.execute(json.dumps(value).encode())
                    self.assertEqual(status.code, 1)
                    self.assertNotIn(SENTINEL, text)
                    self.assertEqual(json.loads(text.splitlines()[1]),
                                     {'validationStage': 'failure_schema', 'driverExitCode': 1,
                                      'driverStatus': 'child_unavailable' if status_name == 'child_unavailable' else 'unknown'})

    def test_strict_boolean_and_count_diagnostics(self):
        profile = {'profile': 'child', 'searched': {'cloudflare account': 0, 'datadog monitor': 0},
                   'deniedCalls': 0, 'deniedCategories': {'tool_search': 0, 'codemode': 0, 'other': 0},
                   'deniedSearchShape': None, 'completed': False, 'modelVerified': False,
                   'discovered': {'cloudflare': 0, 'datadog': 0}, 'metrics': []}
        for change in [{'completed': 0}, {'deniedCalls': True}, {'searched': {'cloudflare account': -1, 'datadog monitor': 0}},
                       {'metrics': [{'profile': 'child', 'phase': 'invalid', 'kind': 'invalid',
                                    'status': 'unavailable', 'utf8Bytes': True, 'codepoints': None,
                                    'activeMcpToolCount': None}]}]:
            with self.subTest(change=change):
                value = {'status': 'child_unavailable', 'diagnostic': {'stage': 'root_child',
                         'profiles': [dict(profile, **change)]}}
                text, status, _ = self.execute(json.dumps(value).encode())
                self.assertEqual(status.code, 1)
                self.assertIn('"validationStage":"failure_schema"', text)

    def test_success_gate_still_rejects_failure_json(self):
        text, status, _ = self.execute(b'{"status":"inference_unavailable","profile":"root"}', returncode=0)
        self.assertIn('"validationStage":"success_schema"', text)
        self.assertNotEqual(status.code, 0)

    def test_root_only_native_search_success_and_no_child_search_claim(self):
        def row(profile):
            root = profile == 'root'
            has_catalog = profile in ('root', 'child')
            phase = 'after_discovery' if has_catalog else 'before_discovery'
            metric = {'profile': profile, 'phase': phase, 'kind': 'provider_payload',
                      'status': 'measured', 'utf8Bytes': 99, 'codepoints': 90,
                      'activeMcpToolCount': 0}
            if root:
                after = dict(metric, phase='after_search', activeMcpToolCount=11)
                metrics = [metric, after]
            else:
                metrics = [metric]
            return {'profile': profile, 'catalogCount': 2 if has_catalog else 0,
                    'exposedToolCount': 36 if has_catalog else 0,
                    'searchCount': 2 if root else 0,
                    'searchActor': 'sdk_native_harness' if root else 'none',
                    'deniedCalls': 0, 'metrics': metrics}
        profiles = ['independent_empty_baseline', 'baseline_child', 'root', 'child']
        value = {'status': 'measured', 'model': 'openai-codex/gpt-6.1-sol',
                 'report': [row(profile) for profile in profiles]}
        text, status, _ = self.execute(json.dumps(value).encode(), returncode=0)
        self.assertEqual(status.code, 0, text)
        for mutation in [
            {'child': {'exposedToolCount': 0}},
            {'child': {'catalogCount': 0}},
            {'child': {'metrics': [dict(value['report'][-1]['metrics'][0], activeMcpToolCount=1)]}},
            {'child': {'searchCount': 2}},
            {'child': {'searchActor': 'sdk_native_harness'}},
            {'root': {'searchCount': 0}},
            {'root': {'searchActor': 'none'}},
            {'child': {'metrics': [dict(value['report'][-1]['metrics'][0], phase='after_search')]}},
        ]:
            with self.subTest(mutation=mutation):
                invalid = json.loads(json.dumps(value))
                target, changes = next(iter(mutation.items()))
                invalid['report'][profiles.index(target)].update(changes)
                text, status, _ = self.execute(json.dumps(invalid).encode(), returncode=0)
                self.assertIn('"validationStage":"success_schema"', text)
                self.assertNotEqual(status.code, 0)

    def test_invalid_dependency_graph_stops_before_guest(self):
        text, status, calls = self.execute(b'', graph_returncode=1)
        self.assertIn('dependency graph invalid', text)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(status.code, 0)


if __name__ == '__main__':
    unittest.main()

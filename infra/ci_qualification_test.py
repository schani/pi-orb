import copy
import unittest
import os
import json
import urllib.error
from unittest.mock import patch
from infra.ci_qualification import EXPECTED, REPOSITORY, GitHub, Result, inspect, wait, valid_evidence, main

SHA = 'a' * 40


class FakeAPI:
    def __init__(self):
        self.runs = {}
        self.jobs = {}
        for index, (path, (name, names)) in enumerate(EXPECTED.items(), 1):
            self.runs[path] = [{'id': index, 'workflow_id': index + 10, 'name': name,
                                'path': '.github/workflows/' + path, 'event': 'push',
                                'head_branch': 'main', 'head_sha': SHA, 'run_attempt': 1,
                                'repository': {'full_name': REPOSITORY},
                                'head_repository': {'full_name': REPOSITORY},
                                'status': 'completed', 'conclusion': 'success'}]
            self.jobs[index] = [{'id': index * 100 + n, 'name': job, 'run_id': index,
                                 'run_attempt': 1, 'head_sha': SHA,
                                 'status': 'completed', 'conclusion': 'success'}
                                for n, job in enumerate(names)]

    def list_runs(self, path, _sha):
        return Result(self.runs[path])

    def list_jobs(self, run_id):
        return Result(self.jobs[run_id])


class QualificationTest(unittest.TestCase):
    def test_complete_exact_main_push_produces_allowlisted_evidence(self):
        result = inspect(FakeAPI(), SHA)
        self.assertIsNone(result.error)
        self.assertTrue(valid_evidence(result.value, SHA))
        self.assertEqual(len(result.value['runs']), 2)
        self.assertEqual(len(result.value['runs'][1]['jobs']), 4)
        self.assertFalse(valid_evidence({**result.value, 'token': 'secret'}, SHA))
        self.assertFalse(valid_evidence(result.value, 'b' * 40))

    def test_wrong_identity_and_reruns_fail_closed(self):
        for key, value in [('event', 'pull_request'), ('head_branch', 'feature'),
                           ('head_sha', 'b' * 40), ('run_attempt', 2),
                           ('repository', {'full_name': 'evil/fork'}), ('repository', None),
                           ('head_repository', []),
                           ('head_repository', {'full_name': 'evil/fork'}),
                           ('name', 'CI impostor'), ('path', '.github/workflows/other.yml')]:
            with self.subTest(key=key):
                api = FakeAPI()
                api.runs['ci.yml'][0][key] = value
                self.assertIsNotNone(inspect(api, SHA).error)

    def test_failed_cancelled_skipped_and_incomplete_jobs_block(self):
        for conclusion in ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', None]:
            api = FakeAPI()
            api.jobs[2][0]['conclusion'] = conclusion
            self.assertIsNotNone(inspect(api, SHA).error)
        for transform in [lambda jobs: jobs[:-1], lambda jobs: jobs + [jobs[0]],
                          lambda jobs: [{**jobs[0], 'run_attempt': 2}] + jobs[1:],
                          lambda jobs: [{**jobs[0], 'name': []}] + jobs[1:],
                          lambda jobs: [{**jobs[0], 'head_sha': 'b' * 40}] + jobs[1:]]:
            api = FakeAPI()
            api.jobs[2] = transform(api.jobs[2])
            self.assertIsNotNone(inspect(api, SHA).error)

    def test_failed_run_and_duplicate_success_never_select_success(self):
        api = FakeAPI()
        api.runs['ci.yml'][0]['conclusion'] = 'failure'
        self.assertEqual(inspect(api, SHA).error.kind, 'invalid')
        api.runs['ci.yml'].append({**api.runs['ci.yml'][0], 'id': 90, 'conclusion': 'success'})
        self.assertIsNotNone(inspect(api, SHA).error)

    def test_missing_or_running_wait_boundedly_then_fail(self):
        for missing in [True, False]:
            api = FakeAPI()
            if missing:
                api.runs['ci.yml'] = []
            else:
                api.runs['ci.yml'][0].update(status='in_progress', conclusion=None)
            clock = [0]
            def sleep(seconds):
                clock[0] += seconds
            result = wait(api, SHA, timeout=30, clock=lambda: clock[0], sleep=sleep, log=lambda _: None)
            self.assertEqual(clock[0], 30)
            self.assertEqual(result.error.kind, 'timeout')

    def test_wait_observes_completion_without_real_sleep(self):
        api = FakeAPI()
        api.runs['ci.yml'][0].update(status='in_progress', conclusion=None)
        clock = [0]
        def sleep(seconds):
            clock[0] += seconds
            api.runs['ci.yml'][0].update(status='completed', conclusion='success')
        result = wait(api, SHA, timeout=30, clock=lambda: clock[0], sleep=sleep, log=lambda _: None)
        self.assertIsNone(result.error)
        self.assertEqual(clock[0], 15)

    def test_api_incomplete_inventory_and_errors_fail_closed(self):
        api = GitHub('secret')
        for data in [{'total_count': 101, 'workflow_runs': []},
                     {'total_count': 1, 'workflow_runs': []}, {},
                     {'total_count': 1, 'workflow_runs': [None]}]:
            with patch.object(api, 'get', return_value=Result(data)):
                self.assertIsNotNone(api.list_runs('ci.yml', SHA).error)
        with patch('urllib.request.OpenerDirector.open', side_effect=urllib.error.HTTPError('private', 403, 'secret', {}, None)):
            result = api.get('/actions/workflows/ci.yml/runs')
            self.assertEqual(result.error.kind, 'http')
            self.assertIn('403', result.error.message)
            self.assertNotIn('secret', result.error.message)

    def test_network_errors_are_classified_and_redirects_are_disabled(self):
        from infra.ci_qualification import NoRedirect
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))
        for error in [TimeoutError('secret'), OSError('secret'), ValueError('secret')]:
            with patch('urllib.request.OpenerDirector.open', side_effect=error):
                result = GitHub('token').get('/actions/runs')
                self.assertEqual(result.error.kind, 'http')
                self.assertNotIn('secret', result.error.message)

    def test_cli_rechecks_handoff_and_rejects_local_skip_context(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': REPOSITORY,
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_WORKFLOW_REF': REPOSITORY + '/.github/workflows/deploy.yml@refs/heads/main',
               'GITHUB_SHA': SHA, 'GH_TOKEN': 'secret',
               'PI_ORB_CI_QUALIFICATION': json.dumps(inspect(FakeAPI(), SHA).value)}
        with patch.dict(os.environ, env, clear=True), patch('infra.ci_qualification.GitHub', return_value=FakeAPI()):
            self.assertEqual(main(['qualify', 'verify']), 0)
            changed = inspect(FakeAPI(), SHA).value
            changed['runs'][0]['runId'] = 999
            os.environ['PI_ORB_CI_QUALIFICATION'] = json.dumps(changed)
            self.assertEqual(main(['qualify', 'verify']), 1)
            os.environ['PI_ORB_CI_QUALIFICATION'] = '{}'
            self.assertEqual(main(['qualify', 'verify']), 1)
            os.environ['GITHUB_EVENT_NAME'] = 'pull_request'
            self.assertEqual(main(['qualify', 'wait']), 1)

    def test_evidence_nested_fields_are_allowlisted(self):
        evidence = inspect(FakeAPI(), SHA).value
        for mutate in [lambda e: e['runs'][0].update(token='secret'),
                       lambda e: e['runs'][1]['jobs'][0].update(stderr='secret'),
                       lambda e: e['runs'][1]['jobs'].pop(),
                       lambda e: e['runs'][0].update(attempt=2)]:
            value = copy.deepcopy(evidence)
            mutate(value)
            self.assertFalse(valid_evidence(value, SHA))


if __name__ == '__main__':
    unittest.main()

import copy
import unittest
import os
import json
import re
import urllib.error
from pathlib import Path
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
    def two_job_ci(self):
        api = FakeAPI()
        # Independent of EXPECTED: CI 37636936479 had both successful jobs.
        api.jobs[1] = [{'id': 100 + n, 'name': name, 'run_id': 1,
                        'run_attempt': 1, 'head_sha': SHA,
                        'status': 'completed', 'conclusion': 'success'}
                       for n, name in enumerate(('checks', 'control-plane-image'))]
        return api

    def test_successful_two_job_ci_run_qualifies(self):
        result = inspect(self.two_job_ci(), SHA)
        self.assertIsNone(result.error)
        self.assertTrue(valid_evidence(result.value, SHA))
        self.assertEqual([job['name'] for job in result.value['runs'][0]['jobs']],
                         ['checks', 'control-plane-image'])

    def test_ci_workflow_jobs_match_qualification_inventory(self):
        workflow = Path('.github/workflows/ci.yml').read_text().split('\njobs:\n', 1)[1]
        job_ids = re.findall(r'^  ([\w-]+):$', workflow, re.MULTILINE)
        self.assertCountEqual(job_ids, EXPECTED['ci.yml'][1])
        # CI uses default job names; explicit display names would change the API contract.
        self.assertNotRegex(workflow, r'(?m)^    name:')

    def test_ci_image_job_and_exact_inventory_fail_closed(self):
        for field, values in {
            'conclusion': ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', None],
            'status': ['queued', 'in_progress'],
            'name': ['foreign'], 'head_sha': ['b' * 40],
            'run_id': [999], 'run_attempt': [2], 'id': [0, 100],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    api = self.two_job_ci()
                    api.jobs[1][1][field] = value
                    self.assertIsNotNone(inspect(api, SHA).error)
        for indices in [(0,), (1,), (0, 0), (0, 1, 1)]:
            with self.subTest(indices=indices):
                api = self.two_job_ci()
                api.jobs[1] = [api.jobs[1][i] for i in indices]
                self.assertIsNotNone(inspect(api, SHA).error)

    def test_ci_jobs_listing_rejects_incomplete_page(self):
        api = GitHub('secret')
        with patch.object(api, 'get', return_value=Result(
                {'total_count': 2, 'jobs': self.two_job_ci().jobs[1][:1]})):
            self.assertIsNotNone(api.list_jobs(1).error)

    def test_every_required_workflow_runs_on_exact_main_push(self):
        for path in EXPECTED:
            with self.subTest(workflow=path):
                source = Path('.github/workflows/' + path).read_text()
                self.assertRegex(source, r'(?m)^  push:\n    branches:\n      - main$')
        source = Path('.github/workflows/durable-qualification.yml').read_text()
        self.assertIn('  workflow_dispatch:', source)
        self.assertIn('  control-plane-image:', source)
        self.assertIn('name: Central process (${{ matrix.shard }}/4)', source)
        self.assertIn('shard: [1, 2, 3, 4]', source)

    def test_missing_central_image_cannot_be_substituted_by_ci_image(self):
        api = FakeAPI()
        central_run = api.runs['durable-qualification.yml'][0]['id']
        api.jobs[central_run] = [job for job in api.jobs[central_run]
                                 if job['name'] != 'control-plane-image']
        self.assertIsNotNone(inspect(api, SHA).error)

    def test_central_qualification_is_required_for_production(self):
        self.assertEqual(EXPECTED.get('durable-qualification.yml'),
                         ('Durable qualification', ('control-plane-image',
                          *(f'Central process ({i}/4)' for i in range(1, 5)))))
        api = FakeAPI()
        api.runs['durable-qualification.yml'] = []
        self.assertEqual(inspect(api, SHA).error.kind, 'pending')

    def test_complete_exact_main_push_produces_allowlisted_evidence(self):
        result = inspect(FakeAPI(), SHA)
        self.assertIsNone(result.error)
        self.assertTrue(valid_evidence(result.value, SHA))
        self.assertEqual(len(result.value['runs']), 3)
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

    def test_dispatch_e2e_never_qualifies_even_with_four_successful_jobs(self):
        api = FakeAPI()
        api.runs['e2e.yml'][0]['event'] = 'workflow_dispatch'
        self.assertIsNotNone(inspect(api, SHA).error)
        evidence = inspect(FakeAPI(), SHA).value
        self.assertFalse(valid_evidence({**evidence, 'event': 'workflow_dispatch'}, SHA))

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


class ArtifactRetryTest(unittest.TestCase):
    """Offline runner-decision model; no GitHub transport or overwrite atomicity claim."""

    def setUp(self):
        self.source = Path('.github/workflows/durable-qualification.yml').read_text()
        process = self.source.split('\n  control-plane-image:', 1)[0]
        self.steps = ['      - name: ' + part.rstrip() + '\n'
                      for part in process.split('      - name: ')[1:]]
        self.uploads = [step for step in self.steps if 'uses: actions/upload-artifact@' in step]

    @staticmethod
    def field(step, key):
        match = re.search(r'^        ' + re.escape(key) + r': (.+)$', step, re.MULTILINE)
        return match[1] if match else None

    def test_two_adjacent_top_level_attempts_with_identical_inputs(self):
        self.assertEqual(len(self.uploads), 4)
        for first, retry, step_id, condition, name, hidden in [
            (*self.uploads[:2], 'upload_provenance', 'always()', 'local-fake-process', False),
            (*self.uploads[2:], 'upload_failure_evidence', 'failure()', 'central-process', True),
        ]:
            with self.subTest(step_id=step_id):
                self.assertEqual(self.steps.index(retry), self.steps.index(first) + 1)
                self.assertEqual(self.field(first, 'id'), step_id)
                self.assertEqual(self.field(first, 'if'), condition)
                self.assertEqual(self.field(retry, 'if'),
                                 "${{ !cancelled() && steps." + step_id + ".outcome == 'failure' }}")
                self.assertEqual(self.field(first, 'continue-on-error'), 'true')
                self.assertIsNone(self.field(retry, 'continue-on-error'))
                self.assertNotIn('          overwrite:', first)
                self.assertIn('          overwrite: true\n', retry)
                for step in (first, retry):
                    self.assertEqual(self.field(step, 'timeout-minutes'), '5')
                    self.assertEqual(self.field(step, 'uses'),
                                     'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1 (Node 24)')
                    self.assertIn('          name: ' + name +
                                  '-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}\n', step)
                    self.assertIn('          if-no-files-found: ignore\n', step)
                    self.assertIn('          retention-days: 14\n', step)
                    self.assertEqual('          include-hidden-files: true\n' in step, hidden)
                self.assertEqual(first.split('        with:\n')[1],
                                 retry.split('        with:\n')[1].replace('          overwrite: true\n', ''))
        test_step = next(step for step in self.steps if 'run: node scripts/local-fake-provider.mjs' in step)
        self.assertIsNone(self.field(test_step, 'continue-on-error'))
        self.assertIsNone(self.field(test_step, 'if'))
        self.assertIn('    timeout-minutes: 60\n', self.source)
        self.assertIn('    timeout-minutes: 30\n', self.source)
        self.assertEqual(self.source.count('continue-on-error:'), 2)
        self.assertEqual(self.source.count('overwrite:'), 2)

    def decide(self, results, *, test_failed=False, cancel_before=None):
        # Consume scheduled action outcomes using the checked-in predicates and COE.
        failed, cancelled = test_failed, False
        outcomes, calls = {}, []
        results = iter(results)
        for index, step in enumerate(self.uploads):
            cancelled = cancelled or index == cancel_before
            condition = self.field(step, 'if')
            if condition == 'always()':
                active = True
            elif condition == 'failure()':
                active = failed
            else:
                match = re.fullmatch(r"\$\{\{ !cancelled\(\) && steps\.(\w+)\.outcome == 'failure' }}", condition or '')
                self.assertIsNotNone(match, condition)
                active = not cancelled and outcomes.get(match[1]) == 'failure'
            if not active:
                continue
            outcome = next(results)
            # Missing optional files are a successful no-op in upload-artifact.
            if outcome == 'absent':
                self.assertIn('          if-no-files-found: ignore\n', step)
                outcome = 'success'
            calls.append(index)
            outcomes[self.field(step, 'id')] = outcome
            failed = failed or (outcome == 'failure' and self.field(step, 'continue-on-error') != 'true')
        self.assertEqual(list(results), [], 'unused scheduled outcomes')
        return calls, 'cancelled' if cancelled else 'failure' if failed else 'success'

    def test_deterministic_decisions(self):
        cases = [
            ('first success', ['success'], {}, [0], 'success'),
            ('retry recovers', ['failure', 'success'], {}, [0, 1], 'success'),
            ('two failures', ['failure', 'failure', 'absent'], {}, [0, 1, 2], 'failure'),
            ('optional provenance absent', ['absent'], {}, [0], 'success'),
            ('original test failure', ['success', 'success'], {'test_failed': True}, [0, 2], 'failure'),
            ('failure evidence recovers', ['success', 'failure', 'success'], {'test_failed': True}, [0, 2, 3], 'failure'),
            ('failure evidence twice fails', ['success', 'failure', 'failure'], {'test_failed': True}, [0, 2, 3], 'failure'),
            ('optional diagnostics absent', ['success', 'absent'], {'test_failed': True}, [0, 2], 'failure'),
            ('both recover with test failure', ['failure', 'success', 'failure', 'success'], {'test_failed': True}, [0, 1, 2, 3], 'failure'),
            ('cancel before provenance retry', ['failure'], {'cancel_before': 1}, [0], 'cancelled'),
            ('cancel before evidence retry', ['success', 'failure'], {'test_failed': True, 'cancel_before': 3}, [0, 2], 'cancelled'),
            ('already cancelled', ['failure'], {'cancel_before': 0}, [0], 'cancelled'),
        ]
        self.assertEqual(len(self.uploads), 4)
        for label, results, options, calls, conclusion in cases:
            with self.subTest(label=label):
                self.assertEqual(self.decide(results, **options), (calls, conclusion))


if __name__ == '__main__':
    unittest.main()

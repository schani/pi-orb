import copy
import json
from pathlib import Path
import tempfile
import unittest
from infra.release_report import export, report
from infra.release_state_test import STAMP, record


class ReportTest(unittest.TestCase):
    def test_failure_preserves_applied_but_unvalidated_and_retained_resources(self):
        value = record()
        value['fixtures'] = [{'kind': 'orb', 'id': 'fixture-42', 'outcome': 'retained'}]
        value['migrationJob'] = 'pi-orb-migrate-42'
        result = report(value, 'b' * 40, 'failure')
        self.assertIsNone(result.error)
        for text in ('applied-but-unvalidated', 'fixture-42', 'may incur costs', 'retained release lock', 'did not complete successfully'):
            self.assertIn(text, result.value)

    def test_uncertain_native_cleanup_is_visible_without_raw_output(self):
        value = record()
        value['nativeCleanup'] = [{
            'resourceKind': 'instances',
            'target': 'projects/test-project/zones/us-central1-a/instances/native',
            'scope': 'zones/us-central1-a',
            'operation': None,
            'status': 'uncertain',
            'errorCode': 'SUBMIT_FAILED',
        }]
        result = report(value, 'b' * 40, 'failure')
        self.assertIsNone(result.error)
        self.assertIn('Native cleanup requires inspection', result.value)
        self.assertIn('operation `unknown`', result.value)
        self.assertNotIn('stderr', result.value)

    def test_recovery_keeps_source_and_runner_distinct(self):
        value = record()
        value['commit'] = 'a' * 40
        value['validatesRelease'] = 'release-original'
        value.update(outcome='validated', phase='complete', exitCode=0, finishedAt=STAMP)
        result = report(value, 'b' * 40, 'success')
        self.assertIsNone(result.error)
        self.assertIn('original record is unchanged', result.value)
        self.assertIn('a' * 40, result.value)

    def test_success_requires_completed_validation_evidence(self):
        self.assertIsNotNone(report(None, 'b' * 40, 'success').error)
        self.assertIsNotNone(report(record(), 'b' * 40, 'success').error)
        completed = record()
        completed.update(outcome='validated', phase='complete', exitCode=0, finishedAt=STAMP)
        self.assertIsNone(report(completed, 'b' * 40, 'success').error)
        for key, value in (('outcome', 'applied-but-unvalidated'), ('phase', 'retire'), ('exitCode', 1), ('finishedAt', None)):
            broken = {**completed, key: value}
            self.assertIsNotNone(report(broken, 'b' * 40, 'success').error)

    def test_rejects_foreign_records_unknown_nested_data_and_injection(self):
        for change in (
            lambda r: r.update(runnerCommit='a' * 40),
            lambda r: r['artifacts'].update(password='must-not-export'),
            lambda r: r.update(workflowUrl='https://example.com/bearer'),
        ):
            value = copy.deepcopy(record())
            change(value)
            self.assertIsNotNone(report(value, 'b' * 40, 'failure').error)
        self.assertIsNotNone(report(record(), 'b' * 40, 'failure\ncredential').error)

    def test_exports_only_validated_json_not_neighboring_files(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            source = path / 'release.json'
            source.write_text(json.dumps(record()))
            (path / 'credentials.json').write_text('must-not-export')
            result = export(source, path / 'artifact', 'b' * 40, 'failure', path / 'summary')
            self.assertIsNone(result.error)
            self.assertEqual([p.name for p in (path / 'artifact').iterdir()], ['release.json'])
            self.assertEqual((path / 'artifact/release.json').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('must-not-export', (path / 'summary').read_text())

    def test_missing_record_reports_no_validation_without_fabricating_artifact(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            result = export(path / 'missing', path / 'artifact', 'b' * 40, 'skipped', path / 'summary')
            self.assertIsNone(result.error)
            self.assertFalse((path / 'artifact').exists())
            self.assertIn('No validated deployment', (path / 'summary').read_text())

    def test_invalid_record_never_becomes_an_artifact(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            source = path / 'release.json'
            source.write_text(json.dumps({'password': 'must-not-export'}))
            self.assertIsNotNone(export(source, path / 'artifact', 'b' * 40, 'failure', path / 'summary').error)
            self.assertFalse((path / 'artifact').exists())


class QualificationReportTest(unittest.TestCase):
    def test_reused_runs_are_linked_in_summary(self):
        from infra.ci_qualification_test import FakeAPI, SHA
        from infra.ci_qualification import inspect
        value = record()
        value['commit'] = SHA
        value['qualification'] = inspect(FakeAPI(), SHA).value
        result = report(value, value['runnerCommit'], 'failure')
        self.assertIsNone(result.error)
        self.assertIn('https://github.com/schani/pi-orb/actions/runs/2/attempts/1', result.value)


class WorkflowContractTest(unittest.TestCase):
    def test_only_release_job_holds_non_cancelling_production_concurrency(self):
        workflow = Path('.github/workflows/deploy.yml').read_text()
        qualification, release = workflow.split('  release:\n', 1)
        self.assertNotIn('concurrency:', qualification)
        self.assertIn('    concurrency:\n      group: pi-orb-production-release\n      cancel-in-progress: false\n', release)
        self.assertEqual(workflow.count('concurrency:'), 1)

    def test_read_only_qualification_precedes_deployment_and_recovery_bypasses_it(self):
        workflow = Path('.github/workflows/deploy.yml').read_text()
        qualification, release = workflow.split('  release:\n', 1)
        self.assertIn('  qualify:', qualification)
        self.assertIn('actions: read', qualification)
        self.assertNotIn('id-token: write', qualification)
        self.assertNotIn('google-github-actions', qualification)
        self.assertIn("inputs.validate_release == ''", qualification)
        self.assertIn('python3 -m infra.ci_qualification wait', qualification)
        self.assertIn('needs: qualify', release)
        self.assertIn("needs.qualify.result == 'success'", release)
        self.assertIn("inputs.validate_release != ''", release)
        self.assertIn('PI_ORB_CI_QUALIFICATION: ${{ needs.qualify.outputs.evidence }}', release)
        self.assertIn('GITHUB_STEP_SUMMARY', qualification)


    def test_manual_exact_commit_shared_transaction_and_allowlisted_artifact(self):
        import re
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotRegex(workflow, r'(?m)^  (push|pull_request):')
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('timeout-minutes: 240', workflow)
        self.assertIn('install_components: beta', workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('git checkout -B main "$GITHUB_SHA"', workflow)
        self.assertIn('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"', workflow)
        self.assertLess(workflow.index('python3 infra/artifact_guard.py'), workflow.index('google-github-actions/auth@'))
        steps = re.findall(r'      - name: ([^\n]+)\n(.*?)(?=      - name: |\Z)', workflow, re.S)
        checkout = 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'
        upload = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
        actions = [(name, action) for name, body in steps for action in re.findall(r'uses: ([^\s]+)', body)]
        self.assertEqual(re.findall(r'uses: ([^\s]+)', workflow), [action for _, action in actions])
        self.assertEqual(
            actions,
            [
                ('Check out the dispatched commit', checkout),
                ('Check out the dispatched commit', checkout),
                ('Set up Node.js', 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'),
                ('Authenticate the GitHub deployment identity', 'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093'),
                ('Set up Google Cloud SDK', 'google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db'),
                ('Upload missing-orb navigation failure evidence', upload),
                ('Upload lazy-return browser failure evidence', upload),
                ('Upload MCP failure summaries', upload),
                ('Upload only the validated release record', upload),
            ],
        )
        uploads = {
            'Upload missing-orb navigation failure evidence': (
                'failure()', 'e2e-missing-orb', 14,
                ['path: |', '  test-failures/missing-orb-*/failure.json',
                 '  test-failures/missing-orb-*/desktop.png', '  test-failures/missing-orb-*/geometry.json'],
            ),
            'Upload lazy-return browser failure evidence': (
                'failure()', 'release-lazy-return', 14,
                ['path: |', '  test-failures/lazy-return-*/failure.json',
                 '  test-failures/lazy-return-*/failure.png', '  test-failures/lazy-return-*/trace.zip'],
            ),
            'Upload MCP failure summaries': (
                'failure()', 'release-mcp', 14, ['path: test-failures/mcp-*.json'],
            ),
            'Upload only the validated release record': (
                'always()', 'release', 30, ['path: ${{ runner.temp }}/release-artifact/release.json'],
            ),
        }
        for name, (condition, artifact, retention, paths) in uploads.items():
            with self.subTest(upload=name):
                body = dict(steps)[name]
                lines = [line[8:].split(' #', 1)[0] for line in body.splitlines() if line.strip()]
                self.assertEqual(lines, [
                    f'if: {condition}', f'uses: {upload}', 'with:',
                    f'  name: {artifact}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}',
                    *['  ' + path for path in paths],
                    '  if-no-files-found: ignore', f'  retention-days: {retention}',
                ])
        self.assertIn('cache: npm', workflow)
        self.assertNotIn('Cache Playwright browsers', workflow)
        self.assertEqual(workflow.count('./infra/release.sh'), 1)
        self.assertIn('exec ./infra/release.sh "${args[@]}"', workflow)
        self.assertIn('args+=(--validate "$VALIDATE_RELEASE")', workflow)
        self.assertIn('python3 -m infra.release_report', workflow)
        self.assertIn('path: ${{ runner.temp }}/release-artifact/release.json', workflow)
        self.assertNotIn('tofu apply', workflow)
        self.assertNotIn('continue-on-error:', workflow)


if __name__ == '__main__':
    unittest.main()

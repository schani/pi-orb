import copy
import json
from pathlib import Path
import tempfile
import unittest
from infra.release_report import export, report
from infra.release_state_test import record


class ReportTest(unittest.TestCase):
    def test_failure_preserves_applied_but_unvalidated_and_retained_resources(self):
        value = record()
        value['fixtures'] = [{'kind': 'orb', 'id': 'fixture-42', 'outcome': 'retained'}]
        value['migrationJob'] = 'pi-orb-migrate-42'
        result = report(value, 'b' * 40, 'failure')
        self.assertIsNone(result.error)
        for text in ('applied-but-unvalidated', 'fixture-42', 'may incur costs', 'retained release lock', 'did not complete successfully'):
            self.assertIn(text, result.value)

    def test_recovery_keeps_source_and_runner_distinct(self):
        value = record()
        value['commit'] = 'a' * 40
        value['validatesRelease'] = 'release-original'
        result = report(value, 'b' * 40, 'success')
        self.assertIsNone(result.error)
        self.assertIn('original record is unchanged', result.value)
        self.assertIn('a' * 40, result.value)

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


class WorkflowContractTest(unittest.TestCase):
    def test_manual_exact_commit_shared_transaction_and_allowlisted_artifact(self):
        import re
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotRegex(workflow, r'(?m)^  (push|pull_request):')
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('timeout-minutes: 240', workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('git checkout -B main "$GITHUB_SHA"', workflow)
        self.assertIn('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"', workflow)
        self.assertLess(workflow.index('python3 infra/artifact_guard.py'), workflow.index('google-github-actions/auth@'))
        actions = re.findall(r'uses: ([^\s]+)', workflow)
        self.assertEqual(len(actions), 5)
        self.assertTrue(all(re.fullmatch(r'[A-Za-z0-9_./-]+@[a-f0-9]{40}', action) for action in actions))
        self.assertEqual(workflow.count('./infra/release.sh'), 1)
        self.assertIn('args+=(--validate "$VALIDATE_RELEASE")', workflow)
        self.assertIn('python3 -m infra.release_report', workflow)
        self.assertIn('path: ${{ runner.temp }}/release-artifact/release.json', workflow)
        self.assertNotIn('tofu apply', workflow)
        self.assertNotIn('continue-on-error:', workflow)


if __name__ == '__main__':
    unittest.main()

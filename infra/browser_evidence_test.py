from pathlib import Path
import json
import re
import unittest
from infra.workflow_testkit import steps as workflow_steps


ROOT = Path(__file__).resolve().parents[1]


def steps(workflow):
    return dict(workflow_steps(workflow))


class BrowserEvidenceTest(unittest.TestCase):
    def test_durable_qualification_covers_final_source_without_deployment(self):
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        for value in ('postgres:17', 'PI_ORB_TEST_DATABASE_URL:', 'PI_ORB_DURABLE_PG_TEST_URL:'):
            self.assertIn(value, ci)
        self.assertIn('vitest run --maxWorkers=1 --no-file-parallelism', ci)
        self.assertIn('npm run test:infra', ci)
        docker = (ROOT / '.github/workflows/e2e.yml').read_text()
        self.assertIn('PI_ORB_E2E_BACKEND: docker', docker)
        qualification = (ROOT / '.github/workflows/durable-qualification.yml').read_text()
        for value in ('pull_request:', 'contents: read', 'shard: [1, 2, 3, 4]',
                      'PI_ORB_E2E_BACKEND: process',
                      'npm run test:e2e -- --project process --project provider --shard=',
                      'retention-days: 14'):
            self.assertIn(value, qualification)
        for value in ('id-token: write', 'google-github-actions', 'infra/release.sh'):
            self.assertNotIn(value, qualification)

    def test_durable_failure_evidence_is_explicit_and_captures_stderr(self):
        process = steps('durable-qualification.yml')['Upload failure evidence']
        for pattern in (
            'test-failures/durable-process-*/failure.txt',
            'test-failures/durable-process-*/control-plane.log',
            'test-failures/durable-process-*/model-requests.json',
            'test-failures/durable-independent-process/*/failure.txt',
            'test-failures/durable-independent-process/*/control-plane.log',
            'test-failures/durable-independent-process/*/browser-frames.json',
            'test-failures/durable-independent-process/*/model-requests.json',
            'test-failures/durable-independent-process/*/barrier.json',
            'test-failures/durable-independent-process/*/waiting-phases.json',
        ):
            self.assertIn(pattern, process)
        for upload in (process, steps('e2e.yml')['Upload Durable failure diagnostics']):
            for filename in ('control-plane.log', 'relay-requests.json', 'model-requests.json',
                             'retained-docker.json', 'execution-ready.json'):
                self.assertIn('test-failures/cross-axis-*/' + filename, upload)
            self.assertNotIn('/**', upload)
            self.assertNotRegex(upload, r'(?m)^            .*/\\*\\s*$')
        proof = steps('ci.yml')['Prove packaged worker, Git and skills without network']
        self.assertIn('2>&1 | tee', proof)

    def test_nested_failure_producers_have_bounded_uploads(self):
        producers = {
            'e2e/transcript-cache-stopped.e2e.test.ts': ('test-failures/stopped-cache-*', ['evidence.json', 'failure.png', 'trace.zip'], ['e2e.yml']),
            'e2e/full-slice.e2e.test.ts': ('test-failures/full-slice-orb-*', ['failure.txt', 'control-plane.log', 'failing-orb.json', 'failing-history.json', 'capture-outcomes.json'], ['e2e.yml', 'durable-qualification.yml']),
            'e2e/empty-live-reasoning-frontend.e2e.test.ts': ('.context/empty-live-reasoning/simplification/*-first-failure', ['error.txt', 'frames.json', 'detail-requests.json', 'page-errors.json', 'page.html', 'page.png'], ['e2e.yml']),
            'e2e/orb-alerts.e2e.test.ts': ('.context/orb-alerts/evidence/*', ['failure.txt', 'control-plane.log', 'orb.json', 'history.json'], ['durable-qualification.yml']),
            'e2e/orb-sleep.e2e.test.ts': ('.context/orb-sleep/evidence/*', ['failure.txt', 'manifest.json', 'control-plane.log', 'orb-view.json', 'history.json', 'messages.json'], ['durable-qualification.yml']),
        }
        expected = {workflow: set() for workflow in ('e2e.yml', 'durable-qualification.yml')}
        for producer, (directory, leaves, workflows) in producers.items():
            source = (ROOT / producer).read_text()
            for leaf in leaves:
                self.assertIn('"' + leaf + '"', source, producer)
                for workflow in workflows:
                    expected[workflow].add(directory + '/' + leaf)
        for workflow in ('e2e.yml', 'durable-qualification.yml'):
            step = steps(workflow)['Upload nested scenario failure evidence']
            path = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', step, re.M)
            self.assertEqual(set(path.group(1).split()), expected[workflow])
            for policy in ('if: failure()', 'include-hidden-files: true', 'if-no-files-found: ignore', 'retention-days: 14'):
                self.assertIn(policy, step)
        missing = steps('e2e.yml')['Upload missing-orb navigation failure evidence']
        path = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', missing, re.M)
        self.assertEqual(set(path.group(1).split()), {
            'test-failures/missing-orb-*/' + leaf for leaf in ('failure.json', 'desktop.png', 'geometry.json')
        })
        import fnmatch
        for forbidden in ('test-failures/full-slice-orb-test/fixture/auth/token',
                          '.context/orb-alerts/evidence/test/host/auth.json',
                          '.context/orb-sleep/evidence/test/host/workspace/private.txt'):
            self.assertFalse(any(fnmatch.fnmatchcase(forbidden, pattern) for paths in expected.values() for pattern in paths))

    def test_ci_exercises_provider_supervisor_contracts(self):
        scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
        self.assertIn('scripts/local-fake-provider.test.mjs', scripts['test:infra'])
        self.assertNotIn('scripts/local-fake-provider.smoke.test.mjs', scripts['test:infra'])

    def test_acceptance_jobs_own_their_pinned_fake_provider(self):
        for workflow, step_name in (
            ('e2e.yml', 'Run end-to-end test'),
            ('durable-qualification.yml', 'Run central process end-to-end tests'),
        ):
            with self.subTest(workflow=workflow):
                inventory = steps(workflow)
                run = inventory[step_name]
                projects = 'frontend --project provider --project postgres' if workflow == 'e2e.yml' else 'process --project provider'
                self.assertIn('node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project ' + projects + ' --shard=', run)
                self.assertIn('PI_ORB_LOCAL_FAKE_EVIDENCE:', run)
                upload = inventory['Upload local provider provenance']
                self.assertIn('if: always()', upload)
                paths = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', upload, re.M)
                self.assertIsNotNone(paths)
                self.assertEqual({line.strip() for line in paths.group(1).splitlines()}, {
                    '${{ runner.temp }}/local-fake-provider/manifest.json',
                    '${{ runner.temp }}/local-fake-provider/phases.json',
                })
                self.assertIn('retention-days: 14', upload)
    def test_all_triggers_run_full_matrix_with_prerequisites(self):
        body = (ROOT / '.github/workflows/e2e.yml').read_text()
        self.assertIn('  pull_request:\n  push:\n    branches:\n      - main\n  workflow_dispatch:\n', body)
        self.assertNotIn('    inputs:', body)
        self.assertNotIn('webkit_reload_diagnostic', body)
        self.assertNotIn('Diagnose frontend shard', body)
        self.assertIn('    name: E2E (${{ matrix.shard }}/4)', body)
        self.assertIn('    runs-on: ubuntu-24.04', body)
        self.assertIn('    timeout-minutes: 40', body)
        self.assertIn('        shard: [1, 2, 3, 4]', body)
        workflow_steps = steps('e2e.yml')
        self.assertIn("node-version: '24.22.1'", workflow_steps['Set up Node.js'])
        self.assertIn('run: npm ci', workflow_steps['Install dependencies'])
        self.assertIn('run: npm run test:e2e:install', workflow_steps['Install pinned browser engines and system dependencies'])
        full = workflow_steps['Run end-to-end test']
        self.assertIn('DEBUG: pw:browser', full)
        self.assertIn('run: node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project frontend --project provider --project postgres --shard=${{ matrix.shard }}/4', full)
        self.assertEqual(len(re.findall(r'^        run: (?:node scripts/local-fake-provider.mjs -- )?npm run test:e2e --', body, re.M)), 1)

    def test_lazy_return_owns_and_preserves_failure_evidence(self):
        source = (ROOT / 'e2e/lazy-transcript-frontend.e2e.test.ts').read_text()
        self.assertRegex(source, r'mkdtemp\(\s*join\(import\.meta\.dirname, `\.\./test-failures/lazy-return-\$\{engine\}-`\),\s*\)')
        for filename in ('failure.json', 'failure.png', 'trace.zip'):
            self.assertIn(f'join(evidence, "{filename}")', source)
        self.assertIn('await rm(evidence, { recursive: true', source)

    def test_missing_orb_navigation_evidence_survives_runner_teardown(self):
        source = (ROOT / 'e2e/missing-orb-layout-frontend.e2e.test.ts').read_text()
        self.assertIn('../test-failures/missing-orb-${engine}-${scenario}-', source)
        self.assertIn('join(evidence, "failure.json")', source)
        self.assertIn('join(evidence, "desktop.png")', source)
        self.assertIn('join(evidence, "geometry.json")', source)
        self.assertIn('await page.reload()', source)
        self.assertIn('reloadBoot.wait(', source)
        self.assertIn('await rm(evidence, { recursive: true', source)
        for workflow in ('e2e.yml',):
            with self.subTest(workflow=workflow):
                step = steps(workflow)['Upload missing-orb navigation failure evidence']
                self.assertIn('if: failure()', step)
                path = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', step, re.M)
                self.assertIsNotNone(path)
                self.assertEqual(set(path.group(1).split()), {
                    f'test-failures/missing-orb-*/{name}'
                    for name in ('failure.json', 'desktop.png', 'geometry.json')
                })
                self.assertIn('if-no-files-found: ignore', step)
        self.assertIn('DEBUG: pw:browser', steps('e2e.yml')['Run end-to-end test'])

    def test_e2e_failure_captures_native_fault_and_resource_diagnostics_without_arguments(self):
        step = steps('e2e.yml')['Capture browser failure host diagnostics']
        self.assertIn('if: failure()', step)
        for command in ('df -h', 'free -m', 'ps -eo pid,ppid,comm,rss',
                        'sudo dmesg --ctime', 'dpkg-query -W'):
            self.assertIn(command, step)
        self.assertIn('segfault|out of memory|oom-kill|killed process', step)
        self.assertNotIn('args', step)
        self.assertNotIn('ulimit', step)

    def test_workflows_upload_only_owned_browser_evidence(self):
        expected = {f'test-failures/lazy-return-*/{name}' for name in ('failure.json', 'failure.png', 'trace.zip')}
        for workflow in ('e2e.yml',):
            with self.subTest(workflow=workflow):
                step = steps(workflow)['Upload lazy-return browser failure evidence']
                self.assertIn('if: failure()', step)
                path = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', step, re.M)
                self.assertIsNotNone(path)
                self.assertEqual(set(path.group(1).split()), expected)
                self.assertIn('if-no-files-found: ignore', step)
        step = steps('e2e.yml')['Upload deterministic failure traces']
        self.assertIn('if: failure()', step)
        path = re.search(r'^          path: \\|\n((?:            [^\n]+\n)+)', step, re.M)
        self.assertIsNotNone(path)
        self.assertEqual(set(path.group(1).split()), {
            'test-failures/*.json',
            'test-failures/profile-login/failure.json',
            'test-failures/full-slice-upload/failure.json',
        })


if __name__ == '__main__':
    unittest.main()

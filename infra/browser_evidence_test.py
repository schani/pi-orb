from pathlib import Path
import json
import re
import os
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def steps(workflow):
    body = (ROOT / '.github/workflows' / workflow).read_text()
    return {name: text for name, text in re.findall(
        r'      - name: ([^\n]+)\n(.*?)(?=      - name: |\Z)', body, re.S
    )}


class BrowserEvidenceTest(unittest.TestCase):
    def test_durable_qualification_covers_final_source_without_deployment(self):
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        for value in ('postgres:16', 'PI_ORB_TEST_DATABASE_URL:', 'PI_ORB_DURABLE_PG_TEST_URL:'):
            self.assertIn(value, ci)
        self.assertIn('vitest run --maxWorkers=1 --no-file-parallelism', ci)
        self.assertIn('npm run test:infra', ci)
        docker = (ROOT / '.github/workflows/e2e.yml').read_text()
        self.assertIn('PI_ORB_E2E_BACKEND: docker', docker)
        self.assertIn('PI_ORB_AGENT_BACKEND: host-pi', docker)
        qualification = (ROOT / '.github/workflows/durable-qualification.yml').read_text()
        for value in ('pull_request:', 'contents: read', 'shard: [1, 2, 3, 4]',
                      'PI_ORB_E2E_BACKEND: process', 'PI_ORB_AGENT_BACKEND: central-durable',
                      'npm run test:e2e -- --shard=',
                      'docker build -f apps/control-plane/Dockerfile',
                      '--network none', 'control-plane-image-proof.mjs',
                      'retention-days: 14', 'df -h', '15728640'):
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
        proof = steps('durable-qualification.yml')['Prove packaged worker, Git and skills without network']
        self.assertIn('2>&1 | tee', proof)

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
                self.assertIn('node scripts/local-fake-provider.mjs -- npm run test:e2e -- --shard=', run)
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
        self.assertIn('      subagent_continuation_diagnostic:\n        description: Capture the first subagent continuation failure (not qualification)\n        type: boolean\n        default: false\n', body)
        self.assertEqual(body.count('    inputs:'), 1)
        self.assertNotIn('webkit_reload_diagnostic', body)
        self.assertNotIn('Diagnose frontend shard', body)
        self.assertIn('    name: E2E (${{ matrix.shard }}/4)', body)
        self.assertIn('    runs-on: ubuntu-24.04', body)
        self.assertIn('    timeout-minutes: 40', body)
        self.assertIn('        shard: [1, 2, 3, 4]', body)
        workflow_steps = steps('e2e.yml')
        self.assertIn("node-version: '24.6.0'", workflow_steps['Set up Node.js'])
        self.assertIn('run: npm ci', workflow_steps['Install dependencies'])
        self.assertIn('run: npm run test:e2e:install', workflow_steps['Install pinned browser engines and system dependencies'])
        full = workflow_steps['Run end-to-end test']
        self.assertIn("if: github.event_name != 'workflow_dispatch' || !inputs.subagent_continuation_diagnostic", full)
        self.assertIn('DEBUG: pw:browser', full)
        self.assertIn('run: node scripts/local-fake-provider.mjs -- npm run test:e2e -- --shard=${{ matrix.shard }}/4', full)
        self.assertEqual(len(re.findall(r'^        run: (?:node scripts/local-fake-provider.mjs -- )?npm run test:e2e --', body, re.M)), 2)

    def test_diagnostic_check_names_cannot_replace_required_checks(self):
        body = (ROOT / '.github/workflows/e2e.yml').read_text()
        name = re.search(r'^    name: (.+)$', body, re.M).group(1)
        suffix = "${{ github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic && ' diagnostic' || '' }}"
        self.assertEqual(name, 'E2E (${{ matrix.shard }}/4)' + suffix)
        for event in ('pull_request', 'push', 'workflow_dispatch'):
            for enabled in (False, True):
                expression = suffix[3:-2].replace('github.event_name', repr(event)).replace(
                    'inputs.subagent_continuation_diagnostic', str(enabled)).replace(
                    '&&', 'and').replace('||', 'or')
                for shard in range(1, 5):
                    rendered = name.replace('${{ matrix.shard }}', str(shard)).replace(
                        suffix, eval(expression, {'__builtins__': {}}))
                    expected = f'E2E ({shard}/4)'
                    if event == 'workflow_dispatch' and enabled:
                        expected += ' diagnostic'
                    self.assertEqual(rendered, expected)

    def test_manual_diagnostic_runs_original_shard_two_once_on_every_runner(self):
        workflow_steps = steps('e2e.yml')
        diagnostic = workflow_steps['Diagnose subagent continuation']
        normal = workflow_steps['Run end-to-end test']
        guards = [re.search(r'^        if: (.+)$', step, re.M).group(1)
                  for step in (normal, diagnostic)]
        self.assertEqual(guards[1], "github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic")
        for event in ('pull_request', 'push', 'workflow_dispatch'):
            for enabled in (False, True):
                for shard in range(1, 5):
                    selected = []
                    for guard in guards:
                        expression = guard.replace('github.event_name', repr(event)).replace(
                            'inputs.subagent_continuation_diagnostic', str(enabled)).replace(
                            'matrix.shard', str(shard)).replace('||', 'or').replace('&&', 'and')
                        expression = re.sub(r'!(?!=)', 'not ', expression)
                        selected.append(eval(expression, {'__builtins__': {}}))
                    manual = event == 'workflow_dispatch' and enabled
                    self.assertEqual(selected, [not manual, manual])
        self.assertIn('DEBUG: pw:browser', diagnostic)
        commands = re.findall(r'^        run: (.+)$', diagnostic, re.M)
        self.assertEqual(commands, ['npm run test:e2e -- --shard=2/4'])
        script = commands[0]
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / 'npm'
            stub.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\n'
                            'exit "$STATUS"\n')
            stub.chmod(0o755)
            for status in (0, 17):
                calls = Path(directory) / f'calls-{status}'
                result = subprocess.run(['bash', '-e', '-c', script], capture_output=True,
                                        env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}',
                                             'CALLS': str(calls), 'STATUS': str(status)})
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(calls.read_text().splitlines(),
                                 ['run test:e2e -- --shard=2/4'])

    def test_native_transport_success_upload_is_always_and_exactly_safe_projection(self):
        step = steps('e2e.yml')['Upload subagent native transport success audits']
        self.assertIn('if: always()', step)
        self.assertIn('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', step)
        self.assertEqual(re.search(r'^          path: (.+)$', step, re.M).group(1),
                         'test-failures/subagent-*/success.json')
        self.assertIn('name: subagent-native-transport-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}', step)
        self.assertIn('if-no-files-found: ignore', step)
        self.assertIn('retention-days: 14', step)
        for forbidden in ('native-audit/', '**', 'node-auth', '.log'):
            self.assertNotIn(forbidden, step)

    def test_deploy_uploads_only_sanitized_mcp_failure_summaries(self):
        step = steps('deploy.yml')['Upload MCP failure summaries']
        self.assertIn('if: failure()', step)
        self.assertIn('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', step)
        self.assertEqual(re.search(r'^          path: (.+)$', step, re.M).group(1),
                         'test-failures/mcp-*.json')
        self.assertIn('name: release-mcp-${{ github.run_id }}-${{ github.run_attempt }}', step)
        self.assertIn('if-no-files-found: ignore', step)
        self.assertIn('retention-days: 14', step)

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
        for workflow in ('e2e.yml', 'deploy.yml'):
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
        for workflow in ('e2e.yml', 'deploy.yml'):
            with self.subTest(workflow=workflow):
                step = steps(workflow)['Upload lazy-return browser failure evidence']
                self.assertIn('if: failure()', step)
                path = re.search(r'^          path: \|\n((?:            [^\n]+\n)+)', step, re.M)
                self.assertIsNotNone(path)
                self.assertEqual(set(path.group(1).split()), expected)
                self.assertIn('if-no-files-found: ignore', step)
        self.assertEqual(
            re.search(r'^          path: (.+)$', steps('deploy.yml')['Upload only the validated release record'], re.M).group(1),
            '${{ runner.temp }}/release-artifact/release.json',
        )
        step = steps('e2e.yml')['Upload deterministic failure traces']
        self.assertIn('if: failure()', step)
        path = re.search(r'^          path: \\|\n((?:            [^\n]+\n)+)', step, re.M)
        self.assertIsNotNone(path)
        self.assertEqual(set(path.group(1).split()), {
            'test-failures/*.json',
            'test-failures/profile-login/failure.json',
            'test-failures/full-slice-upload/failure.json',
            'test-failures/subagent-*/failure.json',
        })


if __name__ == '__main__':
    unittest.main()

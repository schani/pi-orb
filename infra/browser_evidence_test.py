from pathlib import Path
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
        self.assertIn('run: npm run test:e2e -- --shard=${{ matrix.shard }}/4', full)
        self.assertEqual(len(re.findall(r'^        run: npm run test:e2e --', body, re.M)), 1)

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

    def test_manual_diagnostic_is_shard_two_only_and_stops_at_first_failure(self):
        workflow_steps = steps('e2e.yml')
        diagnostic = workflow_steps['Diagnose subagent continuation']
        normal = workflow_steps['Run end-to-end test']
        guards = [re.search(r'^        if: (.+)$', step, re.M).group(1)
                  for step in (normal, diagnostic)]
        self.assertEqual(guards[1], "github.event_name == 'workflow_dispatch' && inputs.subagent_continuation_diagnostic && matrix.shard == 2")
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
                    self.assertEqual(selected, [not manual, manual and shard == 2])
        self.assertIn('DEBUG: pw:browser', diagnostic)
        script = diagnostic.split('        run: |\n')[1]
        script = '\n'.join(line[10:] for line in script.splitlines())
        self.assertIn('for cycle in 1 2 3 4 5 6; do', script)
        self.assertIn('npm run test:e2e -- --project lifecycle e2e/subagents.e2e.test.ts || exit "$?"', script)
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / 'npm'
            stub.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\n'
                            'count=$(wc -l < "$CALLS")\n'
                            'if [ "$count" = "$FAIL_AT" ]; then exit 17; fi\n')
            stub.chmod(0o755)
            for fail_at, count, status in ((0, 6, 0), (1, 1, 17), (3, 3, 17)):
                calls = Path(directory) / f'calls-{fail_at}'
                result = subprocess.run(['bash', '-e', '-c', script], capture_output=True,
                                        env={**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}',
                                             'CALLS': str(calls), 'FAIL_AT': str(fail_at)})
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(calls.read_text().splitlines(),
                                 ['run test:e2e -- --project lifecycle e2e/subagents.e2e.test.ts'] * count)

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

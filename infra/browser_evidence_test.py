from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def steps(workflow):
    body = (ROOT / '.github/workflows' / workflow).read_text()
    return {name: text for name, text in re.findall(
        r'      - name: ([^\n]+)\n(.*?)(?=      - name: |\Z)', body, re.S
    )}


class BrowserEvidenceTest(unittest.TestCase):
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

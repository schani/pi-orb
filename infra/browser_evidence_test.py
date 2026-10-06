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
        })


if __name__ == '__main__':
    unittest.main()

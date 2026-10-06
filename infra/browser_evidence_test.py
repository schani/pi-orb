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
            'test-failures/subagent-*/failure.json',
        })


if __name__ == '__main__':
    unittest.main()

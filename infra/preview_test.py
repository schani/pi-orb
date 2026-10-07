"""Optional preview ingress configuration and request-log privacy contracts."""
import json
import re
import unittest
from pathlib import Path


class PreviewTest(unittest.TestCase):
    def test_infra_gate_includes_preview_contracts(self):
        package = json.loads(Path('package.json').read_text())
        python_tests = package['scripts']['test:infra'].split('python3 -m unittest ', 1)[1].split(' && ', 1)[0].split()
        self.assertIn('infra/preview_test.py', python_tests)

    def test_preview_origin_is_opt_in_and_only_in_consolidated_service(self):
        variables = Path('infra/variables.tf').read_text()
        self.assertRegex(variables, r'variable "preview_origin" \{[\s\S]*?default\s*= ""')
        self.assertIn('var.preview_origin == "" || can(regex(', variables)
        source = Path('infra/run.tf').read_text()
        self.assertIn('var.preview_origin != "" ? { PI_ORB_PREVIEW_ORIGIN = var.preview_origin } : {}', source)
        self.assertNotIn('PI_ORB_PREVIEW_ORIGIN', Path('infra/browser-redirect.tf').read_text())
        self.assertNotIn('iap_enabled', source)

    def test_preview_request_logging_exclusion_precedes_service_activation(self):
        source = Path('infra/preview.tf').read_text()
        self.assertIn('count       = var.preview_origin != "" ? 1 : 0', source)
        self.assertIn('resource.type="cloud_run_revision"', source)
        self.assertIn('log_id("run.googleapis.com/requests")', source)
        self.assertIn('httpRequest.requestUrl =~', source)
        self.assertIn(r'replace(trimprefix(var.preview_origin, "https://"), ".", "\\\\.")', source)
        self.assertIn(r'[0-9a-f-]{36}\\.', source)
        self.assertIn('google_logging_project_exclusion.preview_requests', Path('infra/run.tf').read_text())
        self.assertNotIn('cloudaudit.googleapis.com', source)

    def test_hostname_match_does_not_exclude_other_origins(self):
        origin = 'https://preview.example.net'
        source = Path('infra/preview.tf').read_text()
        # Terraform heredocs keep literal backslashes; Logging then parses its string.
        expression = source.split('httpRequest.requestUrl =~ ', 1)[1].splitlines()[0]
        interpolation = re.search(r'\$\{[^}]+\}', expression).group()
        expression = expression.replace(interpolation, re.escape(origin.removeprefix('https://')).replace('\\', '\\\\'))
        pattern = json.loads(expression)
        host = 'p5173-o00000000-0000-4000-8000-000000000001'
        self.assertRegex(f'https://{host}.preview.example.net/oauth?code=secret', pattern)
        for value in [f'https://{host}.preview.example.net.attacker.test/', 'https://app.example.net/', f'https://{host}.other.example.net/']:
            self.assertNotRegex(value, pattern)


if __name__ == '__main__':
    unittest.main()

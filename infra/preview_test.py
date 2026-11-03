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
        self.assertNotIn('iap_enabled', source)

    def test_preview_request_logging_exclusion_precedes_service_activation(self):
        source = Path('infra/preview.tf').read_text()
        self.assertIn('count       = var.preview_origin != "" ? 1 : 0', source)
        self.assertIn('resource.type="cloud_run_revision"', source)
        self.assertIn('log_id("run.googleapis.com/requests")', source)
        self.assertIn('httpRequest.requestUrl =~', source)
        self.assertIn(r'replace(trimprefix(var.preview_origin, "https://"), ".", "\\.")', source)
        self.assertIn(r'[0-9a-f-]{36}\.', source)
        self.assertIn('google_logging_project_exclusion.preview_requests', Path('infra/run.tf').read_text())
        self.assertNotIn('cloudaudit.googleapis.com', source)

    def test_hostname_match_does_not_exclude_other_origins(self):
        origin = 'https://preview.example.net'
        source = Path('infra/preview.tf').read_text()
        # Heredocs keep backslashes literally, and Cloud Logging hands the quoted regex to RE2
        # without unescaping: a doubled backslash matches a literal backslash (2026-11-03).
        expression = source.split('httpRequest.requestUrl =~ ', 1)[1].splitlines()[0]
        interpolation = re.search(r'\$\{[^}]+\}', expression).group()
        rendered = expression.replace(interpolation, origin.removeprefix('https://').replace('.', '\\.'))
        pattern = rendered[1:-1]
        self.assertNotIn('\\\\', pattern)
        host = 'p5173-o00000000-0000-4000-8000-000000000001'
        self.assertRegex(f'https://{host}.preview.example.net/oauth?code=secret', pattern)
        for value in [f'https://{host}.preview.example.net.attacker.test/', 'https://app.example.net/', f'https://{host}.other.example.net/', f'https://{host}Xpreview.example.net/']:
            self.assertNotRegex(value, pattern)


    def test_preview_ingress_is_a_wildcard_https_edge_to_the_issuer(self):
        source = Path('infra/preview.tf').read_text()
        for resource in [
            'google_compute_global_address" "preview',
            'google_certificate_manager_dns_authorization" "preview',
            'google_certificate_manager_certificate" "preview',
            'google_certificate_manager_certificate_map" "preview',
            'google_certificate_manager_certificate_map_entry" "preview',
            'google_compute_region_network_endpoint_group" "preview',
            'google_compute_backend_service" "preview',
            'google_compute_url_map" "preview',
            'google_compute_target_https_proxy" "preview',
            'google_compute_global_forwarding_rule" "preview',
            'google_dns_record_set" "preview_wildcard',
            'google_dns_record_set" "preview_certificate_authorization',
        ]:
            block = source.split(f'resource "{resource}" {{', 1)[1].split('\n}', 1)[0]
            self.assertIn('count', block, resource)
        self.assertIn('domains            = ["*.${local.preview_domain}"]', source)
        self.assertIn('service = google_cloud_run_v2_service.issuer.name', source)
        self.assertIn('load_balancing_scheme = "EXTERNAL_MANAGED"', source)
        self.assertIn('port_range            = "443"', source)
        self.assertRegex(source, r'log_config \{\s+enable = false')
        self.assertIn('managed_zone = "pi-orb-preview"', source)
        self.assertNotIn('iap', source)

    def test_production_release_sets_the_preview_origin(self):
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('TF_VAR_preview_origin: https://piorb.live', workflow)

if __name__ == '__main__':
    unittest.main()

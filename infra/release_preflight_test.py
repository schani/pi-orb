import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from infra.release_preflight import EXCLUSION_PERMISSIONS, check_exclusion_authority
from infra.release_state import Result, fail


class FakeCloud:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def http(self, method, url, body):
        self.calls.append((method, url, body))
        return self.result


class PreflightTest(unittest.TestCase):
    def test_migration_timeout_default_override_and_durable_diagnostic(self):
        source = Path("infra/release.sh").read_text()
        parser = source.split('[[ "${PI_ORB_USER_ID:-}"', 1)[0]
        migration = source.split('  release_run_child gcloud run jobs create ', 1)[1].split('\n  if [ "$FIRST_CONSOLIDATION"', 1)[0]
        script = parser + """
release_run_child() { printf '%s\\n' "$@"; }
jq() { echo test-value; }
migration_job=test-job
RECORD=test-record
foundation='{}'
database_version=1
migration_secrets=''
migration_owner_args=()
release_run_child gcloud run jobs create """ + migration
        for args, seconds, reason in [
            ([], 300, "default"),
            (["--migration-timeout-30m"], 1800, "explicit 30-minute override"),
        ]:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as directory:
                summary = Path(directory) / "summary"
                result = subprocess.run(
                    ["bash", "-c", script, "infra/release.sh", *args],
                    env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary)},
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"--task-timeout={seconds}s", result.stdout.splitlines())
                self.assertIn("--max-retries=0", result.stdout.splitlines())
                diagnostic = f"Migration task timeout: {seconds}s ({reason})"
                self.assertIn(diagnostic, result.stdout)
                self.assertIn(diagnostic, summary.read_text())
        self.assertIn('KEEP_REMOTE_LOCK=true\n  release_run_child gcloud run jobs create', source)

    def test_invalid_migration_override_fails_before_cloud_access(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "cloud-called"
            gcloud = Path(directory) / "gcloud"
            gcloud.write_text(f'#!/bin/sh\ntouch "{marker}"\nexit 99\n')
            gcloud.chmod(0o700)
            for args in [
                ["--migration-timeout-30m=invalid"],
                ["--migration-timeout-30m", "3600"],
                ["--migration-timeout-30m", "--validate", "latest"],
            ]:
                with self.subTest(args=args):
                    result = subprocess.run(
                        ["bash", "infra/release.sh", *args],
                        env={**os.environ, "PATH": directory + ":" + os.environ["PATH"]},
                        text=True, capture_output=True, check=False,
                    )
                    self.assertEqual(result.returncode, 2)
                    self.assertFalse(marker.exists())
                    self.assertNotIn("PI_ORB_USER_ID", result.stderr)

    def test_workflow_quotes_migration_override_and_passes_only_explicit_flag(self):
        workflow = Path(".github/workflows/deploy.yml").read_text()
        self.assertIn("      migration_timeout_30m:\n", workflow)
        declaration = workflow.split("      migration_timeout_30m:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("type: boolean", declaration)
        self.assertIn("default: false", declaration)
        self.assertIn("MIGRATION_TIMEOUT_30M: ${{ inputs.migration_timeout_30m }}", workflow)
        run = workflow.split("          args=(--yes)\n", 1)[1].split('\n          exec ./infra/release.sh', 1)[0]
        script = "set -eu\nargs=(--yes)\n" + run + '\nprintf "%s\\n" "${args[@]}"\n'
        for value, accepted in [("", True), ("false", True), ("true", True), ("invalid", False), ("true; exit 0", False)]:
            with self.subTest(value=value):
                result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False,
                                        env={**os.environ, "MIGRATION_TIMEOUT_30M": value,
                                             "VALIDATE_RELEASE": "", "FIRST_CONSOLIDATION": "false"})
                self.assertEqual(result.returncode, 0 if accepted else 2, result.stderr)
                if accepted:
                    self.assertEqual(result.stdout.splitlines(),
                                     ["--yes"] + (["--migration-timeout-30m"] if value == "true" else []))

    def test_complete_authority_is_read_only(self):
        cloud = FakeCloud(Result({"permissions": list(EXCLUSION_PERMISSIONS)}))
        self.assertTrue(check_exclusion_authority(cloud, "example-project").value)
        self.assertEqual(cloud.calls, [(
            "POST",
            "https://cloudresourcemanager.googleapis.com/v1/projects/example-project:testIamPermissions",
            {"permissions": list(EXCLUSION_PERMISSIONS)},
        )])

    def test_each_missing_permission_refuses_with_actionable_diagnostic(self):
        for missing in EXCLUSION_PERMISSIONS:
            cloud = FakeCloud(Result({"permissions": [p for p in EXCLUSION_PERMISSIONS if p != missing]}))
            result = check_exclusion_authority(cloud, "example-project")
            self.assertIn(missing, result.error.message)
            self.assertIn("foundation administrator", result.error.message)

    def test_denied_empty_malformed_and_unavailable_fail_closed(self):
        for response in [{}, None, [], {"permissions": "logging.exclusions.create"}, {"permissions": [1]}]:
            self.assertIsNotNone(check_exclusion_authority(FakeCloud(Result(response)), "p").error)
        failure = fail("http", "cloud request HTTP 403")
        self.assertEqual(check_exclusion_authority(FakeCloud(failure), "p"), failure)

    def test_artifact_uploads_share_the_pinned_node24_action(self):
        pin = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"
        for path in Path(".github/workflows").glob("*.yml"):
            for line in path.read_text().splitlines():
                if "uses: actions/upload-artifact@" in line:
                    self.assertIn(pin, line)

    def test_browser_install_precedes_e2e_in_release_and_workflow(self):
        import json
        package = json.loads(Path("package.json").read_text())
        self.assertEqual(package["scripts"]["test:e2e:install"],
                         "playwright install --with-deps chromium webkit")
        for path, command in [
            ("infra/release.sh", "npm run test:e2e\n"),
            (".github/workflows/e2e.yml", "npm run test:e2e -- --project frontend --project provider --project postgres --shard=${{ matrix.shard }}/4\n"),
        ]:
            script = Path(path).read_text()
            self.assertLess(script.index("npm ci"), script.index("npm run test:e2e:install"))
            self.assertLess(script.index("npm run test:e2e:install"), script.index(command))

    def test_release_dependency_caches_and_single_e2e_runtime_build(self):
        key = "key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}"
        e2e = Path(".github/workflows/e2e.yml").read_text()
        self.assertIn("path: ~/.cache/ms-playwright", e2e)
        self.assertIn(key, e2e)
        self.assertNotIn("ms-playwright", Path(".github/workflows/deploy.yml").read_text())
        for path in [".github/workflows/deploy.yml", ".github/workflows/e2e.yml"]:
            workflow = Path(path).read_text()
            self.assertIn("cache: npm", workflow)
        self.assertEqual(e2e.count("file: apps/orb-runtime/Dockerfile"), 1)
        self.assertNotIn("apps/orb-runtime/Dockerfile", Path(".github/workflows/deploy.yml").read_text())
        self.assertNotIn("apps/orb-runtime/Dockerfile", Path("infra/release.sh").read_text())

    def test_ci_builds_control_plane_without_deployment_authority(self):
        workflow = Path(".github/workflows/ci.yml").read_text()
        self.assertIn("permissions:\n  contents: read\n", workflow)
        build = workflow.split("  control-plane-image:\n", 1)[1].split("\n  checks:\n", 1)[0]
        self.assertIn("runs-on: ubuntu-24.04", build)
        self.assertNotIn("needs:", build)
        for forbidden in ["secrets.", "id-token:", "google-github-actions/", "docker push", "release.sh", "tofu"]:
            self.assertNotIn(forbidden, build)
        guard = build.index("python3 infra/artifact_guard.py")
        disk = build.index("available >= 15 * 1024 * 1024 * 1024")
        command = build.index("docker build -f apps/control-plane/Dockerfile")
        self.assertLess(guard, command)
        self.assertLess(disk, command)
        self.assertIn('-t "pi-orb-control-plane:ci-$GITHUB_SHA" .', build)
        self.assertIn("if: always()", build)
        self.assertIn("docker system df", build)
        ignore = Path(".dockerignore").read_text().splitlines()
        for excluded in [".git", ".context", "**/node_modules", "**/.env*", "**/gha-creds-*.json"]:
            self.assertIn(excluded, ignore)

    def test_check_precedes_checks_build_schema_and_apply(self):
        script = Path("infra/release.sh").read_text()
        check = script.index('python3 -m infra.release_preflight "$PROJECT"')
        self.assertLess(script.index("state publish"), check)
        for stage in ["checks", "build", "schema", "apply"]:
            self.assertLess(check, script.index("stage " + stage))

    def test_foundation_grants_exact_checked_permissions_to_shared_identity(self):
        import re
        iam = Path("infra/foundation/iam.tf").read_text()
        role = re.search(r'resource "google_project_iam_custom_role" "deployer_logging_exclusions" \{(.*?)\n\}', iam, re.S).group(1)
        self.assertEqual(set(re.findall(r'"(logging\.[^"]+)"', role)), set(EXCLUSION_PERMISSIONS))
        binding = re.search(r'resource "google_project_iam_member" "deployer_logging_exclusions" \{(.*?)\n\}', iam, re.S).group(1)
        self.assertIn("google_service_account.deployer.email", binding)
        self.assertIn("google_project_iam_custom_role.deployer_logging_exclusions.name", binding)
        self.assertNotIn("condition", binding)
        self.assertNotIn('"roles/logging.admin"', iam)

    def test_browser_depends_on_callback_protection(self):
        script = Path("infra/run.tf").read_text()
        browser = script.split('resource "google_cloud_run_v2_service" "issuer" {')[1].split('\nresource ')[0]
        dependencies = browser.split("depends_on = [")[1].split("]")[0]
        for resource in ["google_logging_project_exclusion.mcp_oauth_callback",
                         "google_secret_manager_secret_iam_member.cp_mcp_oauth_accessor",
                         "google_secret_manager_secret_iam_member.cp_mcp_oauth_versions"]:
            self.assertIn(resource, dependencies)


if __name__ == "__main__":
    unittest.main()

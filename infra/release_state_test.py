import copy
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from infra.release_state import Cloud, Result, SERVICES, activate, current_vars, fail, main, publish, recover, request_retirement, snapshot, summarize_service, validate_record

IMAGE = "us-central1-docker.pkg.dev/test-project/pi-orb/control-plane@sha256:" + "a" * 64
STAMP = "2026-09-09T12:00:00Z"


def service(name, generation=42):
    return {
        "metadata": {"generation": 2, "annotations": {"run.googleapis.com/iap-enabled": "true"}},
        "status": {"observedGeneration": 2, "latestReadyRevisionName": name + "-new", "latestCreatedRevisionName": name + "-new",
                   "conditions": [{"type": "Ready", "status": "True"}],
                   "traffic": [{"percent": 100, "revisionName": name + "-new", "tag": "files"}]},
        "spec": {"template": {"spec": {"containers": [{"image": IMAGE, "env": [{"name": "PI_ORB_AUTH_MODE", "value": "google"}, {"name": "PI_ORB_HOST_SPEC_GENERATION", "value": str(generation)}]}]}}},
    }


def record():
    return {
        "schemaVersion": 1, "releaseId": "release-42", "commit": "b" * 40, "runnerCommit": "b" * 40,
        "project": "test-project", "region": "us-central1", "zone": "us-central1-a", "workflowUrl": None,
        "validatesRelease": None, "startedAt": STAMP, "finishedAt": None, "phase": "retire", "outcome": "applied-but-unvalidated",
        "exitCode": None, "applyAttempted": True, "gates": {"retire": "running"},
        "artifacts": {"control_plane_image": IMAGE, "deploy_generation": 42,
                      "native_image_resource": "projects/test-project/global/images/native", "native_image_id": "123",
                      "workspace_image_resource": "projects/test-project/global/images/workspace", "workspace_image_id": "456"},
        "previousServing": None,
        "serving": [{"service": name, "revision": name + "-new", "image": IMAGE, "generation": 42} for name in SERVICES],
        "retirement": {"resources": ["pi-orb-old"], "resourcesRetired": True, "excluded": {}, "after": STAMP, "operations": [], "revisions": ["pi-orb-old"], "zeroes": {"pi-orb-old": {"active": STAMP, "idle": STAMP}}},
        "fixtures": [], "migrationJob": None, "nativeCleanup": [], "qualification": None,
    }


class RetirementSchemaTest(unittest.TestCase):
    def test_excluded_proof_is_required_and_disjoint_from_admitted_targets(self):
        value = record()
        value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00.123456789Z"}}
        self.assertTrue(validate_record(value))
        for change in ("missing", "overlap", "state", "date", "offset", "future", "old-admitted", "missing-resources", "invalid-resources", "invalid-fence"):
            with self.subTest(change=change):
                invalid = copy.deepcopy(value)
                retired = invalid["retirement"]
                if change == "missing": del retired["excluded"]
                if change == "overlap": retired["revisions"].append("pi-orb-deleted")
                if change == "state": del retired["excluded"]["pi-orb-deleted"]["idle"]
                if change == "date": retired["excluded"]["pi-orb-deleted"]["idle"] = "2026-02-30T11:59:00Z"
                if change == "offset": retired["excluded"]["pi-orb-deleted"]["idle"] = "2026-09-09T11:59:00+00:00"
                if change == "future": retired["after"] = "2026-02-30T12:00:00Z"
                if change == "old-admitted": retired["zeroes"]["pi-orb-old"]["idle"] = "2026-09-09T11:59:00Z"
                if change == "missing-resources": del retired['resources']
                if change == "invalid-resources": retired['resources'] = ['../foreign-resource']
                if change == "invalid-fence": retired['resourcesRetired'] = 'true'
                self.assertFalse(validate_record(invalid))


class FakeCloud:
    def __init__(self):
        self.authority = {"generation": "7", "body": {"generation": 41}}
        self.writes = []
        self.source = None
        self.changed = False
        self.service_body = None
        self.revision_body = None
        self.reads = []
        self.authority_error = None

    def json(self, args):
        self.reads.append(args)
        if args[:3] == ["run", "revisions", "describe"]:
            return Result(copy.deepcopy(self.revision_body))
        if self.service_body is not None:
            return Result(copy.deepcopy(self.service_body))
        value = service(args[3])
        if self.changed:
            value["spec"]["template"]["spec"]["containers"][0]["image"] = IMAGE.replace("a", "c")
        return Result(value)

    def object(self, _bucket, key):
        self.reads.append(key)
        if key.endswith("active.json"):
            return self.authority_error or Result(self.authority)
        return Result(None if self.source is None else {"generation": "8", "body": self.source})

    def put(self, bucket, key, body, generation):
        self.writes.append((bucket, key, body, generation))
        return Result({"generation": "8"})

    def replace(self, bucket, key, body):
        return self.put(bucket, key, body, "7")


class SmokeFixtureShellTest(unittest.TestCase):
    def test_real_shell_records_fixture_outside_repo_and_propagates_publish_failure(self):
        infra = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            release = path / 'release.json'
            release.write_text(json.dumps(record()))
            gcloud = path / 'gcloud'
            gcloud.write_text('#!/bin/sh\necho PERMISSION_DENIED >&2\nexit 7\n')
            gcloud.chmod(0o700)
            env = {**os.environ, 'DIR': str(infra), 'PI_ORB_RELEASE_RECORD': str(release),
                   'PATH': str(path) + os.pathsep + os.environ['PATH']}
            env.pop('PYTHONPATH', None)
            for outcome in ('requested', 'created', 'retained', 'cleanup-failed', 'deleted'):
                with self.subTest(outcome=outcome):
                    result = subprocess.run(
                        ['bash', '-eu', '-c', 'source "$DIR/smoke-fixtures.sh"; fixture_record orb fixture-42 "$1"',
                         'smoke-fixture-test', outcome], cwd=path, env=env, capture_output=True, text=True)
                    self.assertEqual(json.loads(release.read_text())['fixtures'],
                                     [{'kind': 'orb', 'id': 'fixture-42', 'outcome': outcome}], result.stderr)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('gcloud auth print-access-token exited 7 (PERMISSION_DENIED)', result.stderr)


class ReleaseStateTest(unittest.TestCase):
    def failed_rollout(self):
        cloud = FakeCloud()
        body = service("pi-orb-issuer", 43)
        body["metadata"].update(generation=58, namespace="123456", uid="service-uid")
        body["status"].update(observedGeneration=58, latestCreatedRevisionName="pi-orb-issuer-failed",
                              conditions=[{"type": "Ready", "status": "False"},
                                          {"type": "ConfigurationsReady", "status": "False", "reason": "HealthCheckContainerError"}])
        container = body["spec"]["template"]["spec"]["containers"][0]
        container["image"] = IMAGE.replace("a" * 64, "c" * 64)
        for key, name in {
            "native_image_resource": "PI_ORB_GCE_IMAGE_RESOURCE", "native_image_id": "PI_ORB_GCE_IMAGE_ID",
            "workspace_image_resource": "PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE", "workspace_image_id": "PI_ORB_GCE_WORKSPACE_IMAGE_ID",
        }.items():
            container["env"].append({"name": name, "value": record()["artifacts"][key]})
        revision = {"metadata": {"name": "pi-orb-issuer-new", "namespace": "123456", "generation": 1,
                                 "labels": {"serving.knative.dev/service": "pi-orb-issuer", "serving.knative.dev/serviceUid": "service-uid"}},
                    "spec": copy.deepcopy(body["spec"]["template"]["spec"]),
                    "status": {"observedGeneration": 1, "conditions": [{"type": "Ready", "status": "True"}], "imageDigest": IMAGE}}
        revision["spec"]["containers"][0]["image"] = IMAGE
        revision["spec"]["containers"][0]["env"][1]["value"] = "42"
        for item in container["env"][2:]:
            item["value"] += "9"
        cloud.service_body, cloud.revision_body = body, revision
        cloud.authority["body"]["generation"] = 42
        return cloud

    def test_failed_startup_prior_and_vars_use_immutable_serving_revision(self):
        cloud = self.failed_rollout()
        with tempfile.TemporaryDirectory() as directory, patch("infra.release_state.Cloud", return_value=cloud):
            path, variables = Path(directory) / "record.json", Path(directory) / "current.tfvars"
            path.write_text(json.dumps(record()))
            self.assertEqual(main(["release_state", "previous", str(path)]), 0)
            self.assertEqual(json.loads(path.read_text())["previousServing"], record()["serving"])
            self.assertEqual(main(["release_state", "preflight-vars", str(path), str(variables)]), 0)
            expected = record()["artifacts"]
            self.assertEqual(dict((key, json.loads(value)) for key, value in
                                  (line.split(" = ") for line in variables.read_text().splitlines())), expected)
            self.assertEqual(main(["release_state", "check-previous", str(path)]), 0)
        self.assertEqual(sum(isinstance(call, list) and call[:3] == ["run", "revisions", "describe"] for call in cloud.reads), 3)
        self.assertIn("static-plane/releases/active.json", cloud.reads)
        self.assertTrue(all(call[:3] in (["run", "services", "describe"], ["run", "revisions", "describe"])
                            and call[-4:] == ["--project", "test-project", "--region", "us-central1"]
                            for call in cloud.reads if isinstance(call, list)))
        self.assertEqual(cloud.writes, [])

    def test_ready_prior_preserves_normal_baseline_policy(self):
        cloud = self.failed_rollout()
        cloud.service_body = service("pi-orb-issuer")
        cloud.service_body["spec"]["template"]["spec"] = cloud.revision_body["spec"]
        cloud.authority = None
        self.assertEqual(snapshot(cloud, "test-project", "us-central1", prior=True).value, record()["serving"])
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(current_vars(cloud, record(), Path(directory) / "current.tfvars").error)
        self.assertTrue(all(call[:3] == ["run", "services", "describe"] for call in cloud.reads))
        self.assertEqual(cloud.writes, [])

    def test_failed_startup_does_not_relax_postapply_or_validation(self):
        cloud = self.failed_rollout()
        cloud.source = record()
        self.assertIsNotNone(snapshot(cloud, "test-project", "us-central1").error)
        self.assertIsNotNone(activate(cloud, record()).error)
        self.assertIsNotNone(recover(cloud, record(), "release-42").error)
        with tempfile.TemporaryDirectory() as directory, patch("infra.release_state.Cloud", return_value=cloud):
            path = Path(directory) / "record.json"
            path.write_text(json.dumps(record()))
            for action in ("snapshot", "check"):
                self.assertEqual(main(["release_state", action, str(path)]), 1)
        self.assertFalse(any(isinstance(call, list) and call[1] == "revisions" for call in cloud.reads))
        self.assertEqual(cloud.writes, [])

    def test_failed_startup_prior_rejects_unverified_sources(self):
        cases = [
            ("service_body", ("status", "traffic"), [{"percent": 50, "revisionName": "pi-orb-issuer-new", "tag": "files"}]),
            ("service_body", ("status", "traffic"), [{"percent": 100, "revisionName": "pi-orb-issuer-new", "tag": "files"}, {"percent": 0}]),
            ("service_body", ("status", "traffic", 0, "revisionName"), "pi-orb-issuer-failed"),
            ("service_body", ("status", "traffic", 0, "tag"), None),
            ("service_body", ("status", "traffic", 0, "tag"), "other"),
            ("service_body", ("status", "latestReadyRevisionName"), None),
            ("service_body", ("status", "latestCreatedRevisionName"), None),
            ("service_body", ("status", "observedGeneration"), 57),
            ("service_body", ("metadata", "generation"), "²"),
            ("service_body", ("status", "conditions"), []),
            ("service_body", ("status", "conditions"), [{"type": "Ready", "status": "False"}]),
            ("service_body", ("status", "conditions"), [{"type": "Ready", "status": "False"}, {"type": "Ready", "status": "True"},
                                                       {"type": "ConfigurationsReady", "status": "False", "reason": "HealthCheckContainerError"}]),
            ("service_body", ("status", "conditions", 0, "status"), "Unknown"),
            ("service_body", ("status", "conditions", 0, "status"), "True"),
            ("service_body", ("status", "conditions", 1, "status"), "Unknown"),
            ("service_body", ("status", "conditions", 1, "status"), "True"),
            ("service_body", ("status", "conditions", 1, "reason"), "OtherFailure"),
            ("service_body", ("status", "conditions", 1, "type"), "RoutesReady"),
            ("service_body", ("metadata", "uid"), ""),
            ("service_body", ("metadata", "namespace"), None),
            ("revision_body", ("metadata", "name"), "pi-orb-issuer-wrong"),
            ("revision_body", ("metadata", "namespace"), "wrong"),
            ("revision_body", ("metadata", "labels", "serving.knative.dev/service"), "wrong"),
            ("revision_body", ("metadata", "labels", "serving.knative.dev/serviceUid"), "wrong"),
            ("revision_body", ("metadata", "generation"), 0),
            ("revision_body", ("metadata", "generation"), "²"),
            ("revision_body", ("status", "observedGeneration"), 2),
            ("revision_body", ("status", "conditions", 0, "status"), "False"),
            ("revision_body", ("status", "conditions"), []),
            ("revision_body", ("status", "conditions"), [{"type": "Ready", "status": "True"}, {"type": "Ready", "status": "False"}]),
            ("revision_body", ("spec", "containers"), []),
            ("revision_body", ("spec", "containers", 0, "env"), [{"name": "PI_ORB_AUTH_MODE", "value": "google"}, {"name": "PI_ORB_ROLE", "value": "browser"}]),
            ("revision_body", ("spec", "containers", 0, "image"), "not-pinned"),
            ("revision_body", ("status", "imageDigest"), IMAGE.replace("a" * 64, "c" * 64)),
            ("revision_body", ("spec", "containers", 0, "env", 0, "value"), "local"),
            ("revision_body", ("spec", "containers", 0, "env", 0, "name"), "PI_ORB_ROLE"),
            ("revision_body", ("spec", "containers", 0, "env", 1, "value"), "invalid"),
            ("revision_body", ("spec", "containers", 0, "env", 1, "value"), "²"),
            ("revision_body", ("spec", "containers", 0, "env", 1, "value"), "9" * 5000),
            ("revision_body", ("spec", "containers", 0, "env", 1, "value"), "0"),
            ("revision_body", ("spec", "containers", 0, "env", 1, "name"), "missing-generation"),
            ("revision_body", ("spec", "containers", 0, "env", 2, "value"), "bad-native-resource"),
            ("authority", ("body",), None),
            ("authority", ("body",), {}),
            ("authority", ("body", "generation"), True),
            ("authority", ("body", "generation"), "42"),
            ("authority", ("body", "generation"), 43),
        ]
        for source, path, value in cases:
            with self.subTest(source=source, path=path, value=value):
                cloud = self.failed_rollout()
                target = getattr(cloud, source)
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                self.assertIsNotNone(snapshot(cloud, "test-project", "us-central1", prior=True).error)
                self.assertEqual(cloud.writes, [])
        for authority, error in ((None, None), (None, fail("http", "authority unavailable"))):
            cloud = self.failed_rollout()
            cloud.authority, cloud.authority_error = authority, error
            self.assertIsNotNone(snapshot(cloud, "test-project", "us-central1", prior=True).error)
            self.assertEqual(cloud.writes, [])

    def test_failed_startup_preapply_rechecks_revision_image_and_generation(self):
        for field in ("revision", "image", "generation"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                cloud = self.failed_rollout()
                previous = record()["serving"]
                if field == "revision": previous[0][field] = "pi-orb-issuer-different"
                if field == "image": previous[0][field] = IMAGE.replace("a" * 64, "d" * 64)
                if field == "generation": previous[0][field] = 41
                value = record()
                value["previousServing"] = previous
                path = Path(directory) / "record.json"
                path.write_text(json.dumps(value))
                with patch("infra.release_state.Cloud", return_value=cloud):
                    self.assertEqual(main(["release_state", "check-previous", str(path)]), 1)
                self.assertEqual(cloud.writes, [])

    def test_only_allowlisted_records_can_be_published(self):
        value = record()
        self.assertTrue(validate_record(value))
        for corrupt in [
            {**value, "secret_data": "private-sentinel"},
            {**value, "fixtures": [{"kind": "orb", "id": "x", "outcome": "retained", "token": "private-sentinel"}]},
            {**value, "artifacts": {**value["artifacts"], "password": "private-sentinel"}},
            {**value, "workflowUrl": "https://example.com/private-sentinel"},
            {**value, "nativeCleanup": [{"resourceKind": "instances", "target": "projects/test-project/zones/us-central1-a/instances/native", "scope": "zones/us-central1-a", "operation": "operation-1", "status": "uncertain", "errorCode": "TOKEN", "stderr": "private-sentinel"}]},
        ]:
            cloud = FakeCloud()
            self.assertIsNotNone(publish(cloud, corrupt).error)
            self.assertEqual(cloud.writes, [])

    def test_publication_retains_excluded_retirement_proof(self):
        value = record()
        value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}}
        cloud = FakeCloud()
        self.assertIsNone(publish(cloud, value).error)
        self.assertEqual(cloud.writes[0][2]["retirement"]["excluded"], value["retirement"]["excluded"])
    def test_records_without_external_qualification_remain_valid(self):
        value = record()
        del value['qualification']
        self.assertTrue(validate_record(value))
        cloud = FakeCloud()
        cloud.source = value
        self.assertIsNone(recover(cloud, record(), 'release-42').error)

    def test_qualification_is_allowlisted_and_bound_to_deployed_commit(self):
        from infra.ci_qualification_test import FakeAPI, SHA
        from infra.ci_qualification import inspect
        value = record()
        value['commit'] = SHA
        value['qualification'] = inspect(FakeAPI(), SHA).value
        self.assertTrue(validate_record(value))
        value['qualification']['runs'][0]['attempt'] = 2
        self.assertFalse(validate_record(value))
        value['qualification'] = inspect(FakeAPI(), SHA).value
        value['commit'] = 'b' * 40
        self.assertFalse(validate_record(value))

    def test_recovery_preserves_original_qualification(self):
        from infra.ci_qualification_test import FakeAPI
        from infra.ci_qualification import inspect
        api = FakeAPI()
        for runs in api.runs.values():
            runs[0]['head_sha'] = 'b' * 40
        for jobs in api.jobs.values():
            for job in jobs:
                job['head_sha'] = 'b' * 40
        cloud = FakeCloud()
        cloud.source = record()
        cloud.source['qualification'] = inspect(api, 'b' * 40).value
        recovered = recover(cloud, record(), 'release-42')
        self.assertIsNone(recovered.error)
        self.assertEqual(recovered.value['qualification'], cloud.source['qualification'])

    def test_native_cleanup_is_strictly_allowlisted_and_scope_bound(self):
        value = record()
        valid = {"resourceKind": "instances", "target": "projects/test-project/zones/us-central1-a/instances/native", "scope": "zones/us-central1-a", "operation": "operation-1", "status": "uncertain", "errorCode": "POLL_FAILED"}
        value["nativeCleanup"] = [valid]
        self.assertTrue(validate_record(value))
        for evidence in (
            [{**valid, "target": []}],
            [{**valid, "scope": "global"}],
            [{**valid, "resourceKind": "images"}],
            [{**valid, "target": valid["target"].replace("test-project", "other-project")}],
            [{**valid, "status": "succeeded", "operation": None, "errorCode": None}],
            [{**valid, "stderr": "private-sentinel"}],
        ):
            with self.subTest(evidence=evidence):
                broken = copy.deepcopy(value)
                broken["nativeCleanup"] = evidence
                self.assertFalse(validate_record(broken))

    def test_primary_build_failure_keeps_terminal_cleanup_evidence(self):
        value = record()
        value.update(phase="build", outcome="failed-before-apply", applyAttempted=False,
                     gates={"build": "failed"}, artifacts=None, serving=None)
        value["nativeCleanup"] = [{"resourceKind": "images", "target": "projects/test-project/global/images/native", "scope": "global", "operation": "operation-1", "status": "failed", "errorCode": "RESOURCE_IN_USE"}]
        self.assertTrue(validate_record(value))

    def test_native_cleanup_update_is_saved_before_one_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, evidence_path = root / "release.json", root / "cleanup.json"
            path.write_text(json.dumps(record()))
            evidence = [{"resourceKind": "images", "target": "projects/test-project/global/images/native", "scope": "global", "operation": "operation-1", "status": "submitted", "errorCode": None}]
            evidence_path.write_text(json.dumps(evidence))
            with patch("infra.release_state.publish", return_value=Result()) as published:
                self.assertEqual(main(["release_state", "native-cleanup", str(path), str(evidence_path)]), 0)
            self.assertEqual(json.loads(path.read_text())["nativeCleanup"], evidence)
            published.assert_called_once()

    def test_activation_requires_proof_and_matching_live_artifacts(self):
        for change in ("missing-proof", "missing-resource-fence", "changed-service", "mismatched-artifact", "missing-artifacts", "regression"):
            with self.subTest(change=change):
                value, cloud = record(), FakeCloud()
                if change == "missing-proof": value["retirement"]["zeroes"] = {}
                if change == "missing-resource-fence": value['retirement']['resourcesRetired'] = False
                if change == "changed-service": cloud.changed = True
                if change == "mismatched-artifact": value["artifacts"]["deploy_generation"] = 43
                if change == "missing-artifacts": value["artifacts"] = None
                if change == "regression": cloud.authority["body"]["generation"] = 43
                self.assertIsNotNone(activate(cloud, value).error)
                self.assertEqual(cloud.writes, [])

    def test_activation_is_generation_conditional_and_idempotent(self):
        cloud = FakeCloud()
        self.assertIsNone(activate(cloud, record()).error)
        self.assertEqual(cloud.writes[0][3], "7")
        self.assertEqual(cloud.writes[0][2]["generation"], 42)
        self.assertEqual(cloud.writes[0][2]["retireThroughGeneration"], 41)
        cloud.writes.clear()
        cloud.authority["body"]["generation"] = 42
        self.assertIsNone(activate(cloud, record()).error)
        self.assertEqual(cloud.writes, [])

    def test_retirement_request_preserves_activation_until_proof_then_keeps_cutoff(self):
        cloud, value = FakeCloud(), record()
        cloud.authority['body'].update(releaseId='prior-release', activatedAt=STAMP, retireThroughGeneration=39)
        prior = copy.deepcopy(cloud.authority['body'])
        value['retirement']['zeroes'] = {}
        self.assertIsNone(request_retirement(cloud, value).error)
        self.assertEqual(cloud.writes[0], ('pi-orb-tfstate-test-project', 'static-plane/releases/active.json',
                                          {**prior, 'retireThroughGeneration': 41}, '7'))
        cloud.authority = {'generation': '8', 'body': cloud.writes[0][2]}
        cloud.writes.clear()
        self.assertIsNone(request_retirement(cloud, value).error)
        self.assertEqual(cloud.writes, [])
        self.assertIsNotNone(activate(cloud, value).error)
        self.assertEqual(cloud.writes, [])
        value['retirement'] = record()['retirement']
        self.assertIsNone(activate(cloud, value).error)
        self.assertEqual(cloud.writes[0][3], '8')
        self.assertEqual(cloud.writes[0][2]['retireThroughGeneration'], 41)
        self.assertEqual(cloud.writes[0][2]['generation'], 42)

    def test_retirement_request_and_activation_refuse_to_regress_or_revive_retired_generation(self):
        for body in ({'generation': 43}, {'generation': 41, 'retireThroughGeneration': 42},
                     {'generation': 41, 'retireThroughGeneration': True},
                     {'generation': 41, 'retireThroughGeneration': -1}):
            for action in (request_retirement, activate):
                with self.subTest(body=body, action=action.__name__):
                    cloud = FakeCloud()
                    cloud.authority['body'] = body
                    self.assertIsNotNone(action(cloud, record()).error)
                    self.assertEqual(cloud.writes, [])

    def test_retirement_request_rejects_changed_serving_identity_and_propagates_cas_failure(self):
        cloud = FakeCloud()
        cloud.changed = True
        self.assertIsNotNone(request_retirement(cloud, record()).error)
        self.assertEqual(cloud.writes, [])
        cloud.changed = False
        with patch.object(cloud, 'put', return_value=fail('conflict', 'object changed')):
            self.assertEqual(request_retirement(cloud, record()).error.kind, 'conflict')

    def test_generation_selection_stays_above_a_failed_releases_retirement_cutoff(self):
        cloud = FakeCloud()
        cloud.authority['body']['retireThroughGeneration'] = 47
        with tempfile.TemporaryDirectory() as directory, patch('infra.release_state.Cloud', return_value=cloud):
            path, variables = Path(directory) / 'release.json', Path(directory) / 'release.tfvars'
            path.write_text(json.dumps(record()))
            self.assertEqual(main(['release_state', 'generation', str(path), str(variables)]), 0)
            self.assertEqual(json.loads(path.read_text())['artifacts']['deploy_generation'], 48)
            self.assertIn('deploy_generation = 48\n', variables.read_text())

    def test_empty_process_inventory_still_requires_resource_retirement(self):
        value, cloud = record(), FakeCloud()
        value['retirement']['revisions'] = []
        value['retirement']['zeroes'] = {}
        value['retirement']['resourcesRetired'] = False
        self.assertIsNotNone(activate(cloud, value).error)
        self.assertEqual(cloud.writes, [])
        value['retirement']['resourcesRetired'] = True
        self.assertIsNone(activate(cloud, value).error)

    def test_validation_does_not_overwrite_the_original_failure(self):
        cloud = FakeCloud()
        cloud.source = record()
        cloud.source["gates"]["identity"] = "failed"
        before = copy.deepcopy(cloud.source)
        attempt = record()
        attempt["releaseId"] = "validation-43"
        attempt["commit"] = attempt["runnerCommit"] = "c" * 40
        result = recover(cloud, attempt, "release-42")
        self.assertIsNone(result.error)
        self.assertEqual(result.value["commit"], "b" * 40)
        self.assertEqual(result.value["runnerCommit"], "c" * 40)
        self.assertEqual(result.value["validatesRelease"], "release-42")
        self.assertEqual(cloud.source, before)
        self.assertEqual(cloud.writes, [])

    def test_validation_recovers_post_apply_failure_before_snapshot(self):
        cloud = FakeCloud()
        cloud.source = record()
        cloud.source['serving'] = None
        cloud.source['phase'] = 'apply'
        cloud.source['gates'] = {'apply': 'failed'}
        before = copy.deepcopy(cloud.source)
        result = recover(cloud, record(), 'release-42')
        self.assertIsNone(result.error)
        self.assertEqual(result.value['serving'], record()['serving'])
        self.assertEqual(cloud.source, before)
        cloud.changed = True
        self.assertIsNotNone(recover(cloud, record(), 'release-42').error)

    def test_validation_refuses_changed_revisions(self):
        cloud = FakeCloud()
        cloud.source = record()
        cloud.source["serving"][0]["revision"] = "pi-orb-different"
        self.assertIsNotNone(recover(cloud, record(), "release-42").error)

    def test_application_is_pinned_by_image_revision_and_generation(self):
        self.assertIsNone(snapshot(FakeCloud(), "test-project", "us-central1").error)
        invalid = service("pi-orb")
        invalid["metadata"]["annotations"] = {}
        self.assertIsNotNone(summarize_service("pi-orb", invalid).error)
        for body in (None, {}, {"metadata": None}, {"status": []}, {"spec": {"template": None}}):
            self.assertIsNotNone(summarize_service("pi-orb", body).error)

    def test_production_auth_fails_closed(self):
        for mode in (None, "local", ""):
            body = service("pi-orb-issuer")
            body["spec"]["template"]["spec"]["containers"][0]["env"][0]["value"] = mode
            self.assertIsNotNone(summarize_service("pi-orb-issuer", body).error)

    def test_success_cannot_be_recorded_before_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.json"
            path.write_text(json.dumps(record()))
            self.assertEqual(main(["release_state", "finish", str(path), "0"]), 1)
            self.assertEqual(json.loads(path.read_text())["outcome"], "applied-but-unvalidated")
            self.assertEqual(main(["release_state", "finish", str(path), "7"]), 0)
            self.assertEqual(json.loads(path.read_text())["exitCode"], 7)

    def test_cloud_boundary_never_returns_raw_credential_errors(self):
        cloud = Cloud(run=lambda _args: fail("command", "auth unavailable"))
        self.assertEqual(cloud.http("GET", "https://storage.googleapis.com").error.message, "auth unavailable")


if __name__ == "__main__":
    unittest.main()

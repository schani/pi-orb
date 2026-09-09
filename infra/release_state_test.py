import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from infra.release_state import Cloud, Result, SERVICES, activate, fail, main, publish, recover, snapshot, summarize_service, validate_record

IMAGE = "us-central1-docker.pkg.dev/test-project/pi-orb/control-plane@sha256:" + "a" * 64
STAMP = "2026-09-09T12:00:00Z"


def service(name, generation=42):
    return {
        "metadata": {"generation": 2, "annotations": {"run.googleapis.com/iap-enabled": "true"}},
        "status": {"observedGeneration": 2, "latestReadyRevisionName": name + "-new", "latestCreatedRevisionName": name + "-new",
                   "conditions": [{"type": "Ready", "status": "True"}],
                   "traffic": [{"percent": 100, "revisionName": name + "-new", "tag": "files"}]},
        "spec": {"template": {"spec": {"containers": [{"image": IMAGE, "env": [] if name == "pi-orb-issuer" else [{"name": "PI_ORB_HOST_SPEC_GENERATION", "value": str(generation)}]}]}}},
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
        "serving": [{"service": name, "revision": name + "-new", "image": IMAGE, "generation": None if name == "pi-orb-issuer" else 42} for name in SERVICES],
        "retirement": {"after": STAMP, "operations": [], "revisions": ["pi-orb-old"], "zeroes": {"pi-orb-old": {"active": STAMP, "idle": STAMP}}},
        "fixtures": [], "migrationJob": None,
    }


class FakeCloud:
    def __init__(self):
        self.authority = {"generation": "7", "body": {"generation": 41}}
        self.writes = []
        self.source = None
        self.changed = False

    def json(self, args):
        value = service(args[3])
        if self.changed:
            value["spec"]["template"]["spec"]["containers"][0]["image"] = IMAGE.replace("a", "c")
        return Result(value)

    def object(self, _bucket, key):
        if key.endswith("active.json"):
            return Result(self.authority)
        return Result(None if self.source is None else {"generation": "8", "body": self.source})

    def put(self, bucket, key, body, generation):
        self.writes.append((bucket, key, body, generation))
        return Result({"generation": "8"})

    def replace(self, bucket, key, body):
        return self.put(bucket, key, body, "7")


class ReleaseStateTest(unittest.TestCase):
    def test_only_allowlisted_records_can_be_published(self):
        value = record()
        self.assertTrue(validate_record(value))
        for corrupt in [
            {**value, "secret_data": "private-sentinel"},
            {**value, "fixtures": [{"kind": "orb", "id": "x", "outcome": "retained", "token": "private-sentinel"}]},
            {**value, "artifacts": {**value["artifacts"], "password": "private-sentinel"}},
            {**value, "workflowUrl": "https://example.com/private-sentinel"},
        ]:
            cloud = FakeCloud()
            self.assertIsNotNone(publish(cloud, corrupt).error)
            self.assertEqual(cloud.writes, [])

    def test_activation_requires_proof_and_matching_live_artifacts(self):
        for change in ("missing-proof", "changed-service", "mismatched-artifact", "missing-artifacts", "regression"):
            with self.subTest(change=change):
                value, cloud = record(), FakeCloud()
                if change == "missing-proof": value["retirement"]["zeroes"] = {}
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
        cloud.writes.clear()
        cloud.authority["body"]["generation"] = 42
        self.assertIsNone(activate(cloud, record()).error)
        self.assertEqual(cloud.writes, [])

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

    def test_validation_refuses_changed_revisions(self):
        cloud = FakeCloud()
        cloud.source = record()
        cloud.source["serving"][0]["revision"] = "pi-orb-different"
        self.assertIsNotNone(recover(cloud, record(), "release-42").error)

    def test_issuer_is_pinned_by_image_and_revision_not_lifecycle_configuration(self):
        self.assertIsNone(snapshot(FakeCloud(), "test-project", "us-central1").error)
        invalid = service("pi-orb")
        invalid["metadata"]["annotations"] = {}
        self.assertIsNotNone(summarize_service("pi-orb", invalid).error)
        for body in (None, {}, {"metadata": None}, {"status": []}, {"spec": {"template": None}}):
            self.assertIsNotNone(summarize_service("pi-orb", body).error)

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

from datetime import datetime, timezone
import unittest
from infra.release_retire import evidence, inventory, metrics, wait_for_retirement
from infra.release_state import Result, fail
from infra.release_state_test import record


def series(revision, state, value, stamp="2026-09-09T12:01:00Z", region="us-central1"):
    return {"resource": {"type": "cloud_run_revision", "labels": {"revision_name": revision, "service_name": "pi-orb", "location": region}},
            "metric": {"type": "run.googleapis.com/container/instance_count", "labels": {"state": state}},
            "points": [{"interval": {"endTime": stamp}, "value": {"int64Value": value}}]}


def zeroes(revision="pi-orb-old"):
    return [series(revision, state, "0") for state in ("active", "idle")]


class Pages:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []

    def http(self, method, url):
        self.calls.append((method, url))
        return next(self.pages)

    def json(self, args):
        if args[0] == "compute": return Result([])
        return Result([{"metadata": {"name": "pi-orb-old"}}])


class RetirementTest(unittest.TestCase):
    def pending_record(self):
        value = record()
        value["retirement"]["zeroes"] = {}
        return value

    def test_requires_explicit_zero_for_both_states_after_boundary(self):
        for points in ([], zeroes()[:1], [series("pi-orb-old", "active", "1"), zeroes()[1]],
                       [series("pi-orb-old", state, "0", "2026-09-09T11:59:00Z") for state in ("active", "idle")],
                       [series("pi-orb-old", state, "0", region="elsewhere") for state in ("active", "idle")]):
            result = evidence(self.pending_record(), points, "2026-09-09T12:02:00Z")
            self.assertIsNone(result.error)
            self.assertEqual(result.value["zeroes"], {})
        self.assertEqual(set(evidence(self.pending_record(), zeroes(), "2026-09-09T12:02:00Z").value["zeroes"]), {"pi-orb-old"})

    def test_rejects_future_and_non_integer_points(self):
        for point in (series("pi-orb-old", "active", "0", "2026-09-10T12:00:00Z"), series("pi-orb-old", "active", ""), series("pi-orb-old", "active", None)):
            self.assertIsNotNone(evidence(self.pending_record(), [point], "2026-09-09T12:02:00Z").error)

    def test_all_pages_are_required_even_after_a_zero_page(self):
        cloud = Pages([Result({"timeSeries": zeroes(), "nextPageToken": "next"}), fail("http", "unavailable")])
        self.assertIsNotNone(metrics(cloud, "project", "us-central1", "start", "end").error)
        self.assertEqual(len(cloud.calls), 2)
        self.assertIn("pageToken=next", cloud.calls[1][1])

    def test_repeated_and_invalid_page_tokens_fail_closed(self):
        for pages in ([Result({"nextPageToken": "same"}), Result({"nextPageToken": "same"})], [Result({"nextPageToken": None})]):
            self.assertIsNotNone(metrics(Pages(pages), "project", "region", "start", "end").error)

    def test_deleted_but_live_revision_is_discovered(self):
        cloud = Pages([Result({"timeSeries": [series("pi-orb-deleted", "active", "1")]})])
        result = inventory(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["retirement"]["revisions"], ["pi-orb-deleted", "pi-orb-old"])
        result = evidence(self.pending_record(), zeroes() + [series("pi-orb-deleted", "active", "1")], "2026-09-09T12:02:00Z")
        self.assertIn("pi-orb-deleted", result.value["revisions"])
        self.assertNotIn("pi-orb-deleted", result.value["zeroes"])

    def test_new_positive_refutes_stored_proof_and_positive_wins_timestamp_ties(self):
        value = record()
        result = evidence(value, [series("pi-orb-old", "active", "1", value["retirement"]["after"])], "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["zeroes"], {})

    def test_waiting_schedule_is_deterministic_and_never_pauses_services(self):
        clock = [0]
        cloud = Pages([Result({"timeSeries": [series("pi-orb-old", "active", "1")]}), Result({"timeSeries": zeroes()})])
        checkpoints = []
        result = wait_for_retirement(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration),
                                     checkpoint=lambda value: (checkpoints.append(value["retirement"].copy()) or Result()), limit=15)
        self.assertIsNone(result.error)
        self.assertEqual(clock[0], 15)
        self.assertTrue(all(method == "GET" for method, _ in cloud.calls))
        self.assertEqual(len(checkpoints), 2)

    def test_zero_containers_do_not_hide_unfinished_compute_mutations(self):
        clock = [0]
        cloud = Pages([Result({"timeSeries": zeroes()}), Result({"timeSeries": zeroes()})])
        operations = iter([
            Result([{"name": "operation-old", "status": "RUNNING", "targetLink": "https://www.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a/instances/pi-orb-old"}]),
            Result([]),
        ])
        cloud.json = lambda _args: next(operations)
        result = wait_for_retirement(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=15)
        self.assertIsNone(result.error)
        self.assertEqual(clock[0], 15)
        self.assertEqual(result.value["retirement"]["operations"], [])

    def test_timeout_preserves_failure_instead_of_treating_elapsed_time_as_proof(self):
        clock = [0]
        cloud = Pages([Result({}), Result({})])
        result = wait_for_retirement(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=15)
        self.assertEqual(result.error.kind, "timeout")


if __name__ == "__main__":
    unittest.main()

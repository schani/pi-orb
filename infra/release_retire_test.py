from datetime import datetime, timezone
import unittest
from urllib.parse import parse_qs, urlsplit
from infra.release_retire import evidence, inventory, metrics, wait_for_retirement
from infra.release_state import Result, fail
from infra.release_state_test import record


def series(revision, state, value, stamp="2026-09-09T12:01:00Z", region="us-central1", service="pi-orb"):
    return {"resource": {"type": "cloud_run_revision", "labels": {"revision_name": revision, "service_name": service, "location": region}},
            "metric": {"type": "run.googleapis.com/container/instance_count", "labels": {"state": state}},
            "points": [{"interval": {"endTime": stamp}, "value": {"int64Value": value}}]}


def zeroes(revision="pi-orb-old"):
    return [series(revision, state, "0") for state in ("active", "idle")]


class Pages:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []
        self.json_calls = []

    def http(self, method, url):
        self.calls.append((method, url))
        if 'resource.labels.service_name%3D%22pi-orb%22' not in url:
            return Result({})
        return next(self.pages)

    def json(self, args):
        self.json_calls.append(args)
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

    def test_inventory_includes_former_browser_and_all_identity_writers(self):
        cloud = Pages([Result({})])
        self.assertIsNone(inventory(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z").error)
        services = [call[4] for call in cloud.json_calls if call[0] == "run"]
        self.assertEqual(services, ["pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer"])

    def test_former_browser_remains_live_after_new_issuer_is_serving(self):
        clock = [0]
        value = self.pending_record()
        cloud = Pages([Result({"timeSeries": [series("pi-orb-old", "active", "1")]}), Result({"timeSeries": zeroes()})])
        result = wait_for_retirement(cloud, value, wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=15)
        self.assertIsNone(result.error)
        self.assertEqual(clock[0], 15)
        self.assertEqual(value["serving"][0]["service"], "pi-orb-issuer")
        self.assertIn("pi-orb-old", result.value["retirement"]["zeroes"])

    def test_rejects_future_and_non_integer_points(self):
        for point in (series("pi-orb-old", "active", "0", "2026-09-10T12:00:00Z"), series("pi-orb-old", "active", ""), series("pi-orb-old", "active", None)):
            self.assertIsNotNone(evidence(self.pending_record(), [point], "2026-09-09T12:02:00Z").error)

    def test_monitoring_uses_exact_conjunctive_service_filters(self):
        services = ("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")
        class StrictCloud:
            def __init__(self):
                self.calls = []
            def http(self, method, url):
                query = parse_qs(urlsplit(url).query)
                service = next((name for name in services if query["filter"] == [
                    'metric.type="run.googleapis.com/container/instance_count" AND '
                    'resource.type="cloud_run_revision" AND '
                    f'resource.labels.service_name="{name}" AND '
                    'resource.labels.location="us-central1"']), None)
                if service is None:
                    return fail("http", "Monitoring HTTP 400: invalid filter")
                self.calls.append((method, service, query))
                if service == "pi-orb-ops" and "pageToken" not in query:
                    return Result({"timeSeries": [series("pi-orb-ops-old", "active", "1", service="pi-orb-ops")], "nextPageToken": "second"})
                if service == "pi-orb-ops":
                    return Result({"timeSeries": [series("pi-orb-ops-old", "idle", "0", service="pi-orb-ops")]})
                return Result({})
        cloud = StrictCloud()
        result = metrics(cloud, "project", "us-central1", "start", "end")
        self.assertIsNone(result.error)
        self.assertEqual([(service, query.get("pageToken")) for _, service, query in cloud.calls],
                         [("pi-orb", None), ("pi-orb-ops", None), ("pi-orb-ops", ["second"]),
                          ("pi-orb-runtime-api", None), ("pi-orb-issuer", None)])
        self.assertEqual(len(result.value), 2)
        self.assertTrue(all(method == "GET" for method, _, _ in cloud.calls))

    def test_deleted_legacy_revision_on_later_page_requires_explicit_zero(self):
        class Cloud:
            def json(self, args):
                return Result([])
            def http(self, method, url):
                query = parse_qs(urlsplit(url).query)
                if 'resource.labels.service_name="pi-orb-runtime-api"' not in query["filter"][0]:
                    return Result({})
                if "pageToken" not in query:
                    return Result({"nextPageToken": "next"})
                return Result({"timeSeries": [series("pi-orb-runtime-api-deleted", "active", "1", service="pi-orb-runtime-api")]})
        value = self.pending_record()
        observed = inventory(Cloud(), value, wall=lambda: "2026-09-09T12:02:00Z")
        self.assertIsNone(observed.error)
        self.assertEqual(observed.value["retirement"]["revisions"], ["pi-orb-runtime-api-deleted"])
        self.assertEqual(evidence(observed.value, [], "2026-09-09T12:03:00Z").value["zeroes"], {})

    def test_monitoring_fails_closed_on_error_in_later_service(self):
        class Cloud:
            def __init__(self): self.calls = []
            def http(self, method, url):
                self.calls.append(url)
                return fail("http", "Monitoring HTTP 400") if len(self.calls) == 4 else Result({})
        cloud = Cloud()
        result = metrics(cloud, "project", "us-central1", "start", "end")
        self.assertEqual(result.error.kind, "http")
        self.assertEqual(len(cloud.calls), 4)

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

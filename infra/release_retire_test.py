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
        return Result([])


class RetirementTest(unittest.TestCase):
    def pending_record(self):
        value = record()
        value["retirement"]["zeroes"] = {}
        return value

    def test_normal_release_retires_application_without_waiting_for_browser_redirect(self):
        class Cloud:
            def __init__(self):
                self.before_apply = True
            def json(self, args):
                if args[0] == 'compute': return Result([])
                self.assert_service(args[4])
                name = 'pi-orb-issuer-old' if self.before_apply else 'pi-orb-issuer-new'
                return Result([{'metadata': {'name': name}}])
            def assert_service(self, name):
                if name != 'pi-orb-issuer':
                    raise AssertionError('redirect-only service entered controller retirement')
            def http(self, _method, url):
                query = parse_qs(urlsplit(url).query)
                if 'resource.labels.service_name="pi-orb-issuer"' not in query['filter'][0]:
                    raise AssertionError('redirect-only metrics entered controller retirement')
                points = [series('pi-orb-issuer-old', 'active', '1', service='pi-orb-issuer')]
                if not self.before_apply:
                    points += [series('pi-orb-issuer-old', state, '0', '2026-09-09T12:03:00Z', service='pi-orb-issuer') for state in ('active', 'idle')]
                return Result({'timeSeries': points})
        cloud = Cloud()
        value = self.pending_record()
        inventoried = inventory(cloud, value, wall=lambda: '2026-09-09T12:02:00Z')
        self.assertIsNone(inventoried.error)
        self.assertEqual(value['retirement']['resources'], ['pi-orb-issuer-old'])
        self.assertEqual(value['retirement']['revisions'], ['pi-orb-issuer-old'])
        cloud.before_apply = False
        clock = [0]
        result = wait_for_retirement(cloud, value, wall=lambda: '2026-09-09T12:05:00Z', monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=180)
        self.assertIsNone(result.error)
        self.assertTrue(value['retirement']['resourcesRetired'])
        self.assertIn('pi-orb-issuer-old', value['retirement']['zeroes'])

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
        self.assertIsNone(inventory(cloud, self.pending_record(), wall=lambda: "2026-09-09T12:02:00Z", services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")).error)
        services = [call[4] for call in cloud.json_calls if call[0] == "run"]
        self.assertEqual(services, ["pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer"])

    def test_former_browser_remains_live_after_new_issuer_is_serving(self):
        clock = [0]
        value = self.pending_record()
        cloud = Pages([Result({"timeSeries": [series("pi-orb-old", "active", "1")]}), Result({"timeSeries": zeroes()})])
        result = wait_for_retirement(cloud, value, services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
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
        result = metrics(cloud, "project", "us-central1", "start", "end", services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer"))
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
        observed = inventory(Cloud(), value, services=("pi-orb-runtime-api",), wall=lambda: "2026-09-09T12:02:00Z")
        self.assertIsNone(observed.error)
        self.assertEqual(observed.value["retirement"]["revisions"], ["pi-orb-runtime-api-deleted"])
        self.assertEqual(evidence(observed.value, [], "2026-09-09T12:03:00Z").value["zeroes"], {})

    def test_deleted_revision_complete_preboundary_zeroes_need_no_new_emission(self):
        points = [series("pi-orb-deleted", "active", "1", "2026-09-09T11:58:00Z")]
        points += [series("pi-orb-deleted", state, "0", "2026-09-09T11:59:00Z") for state in ("active", "idle")]
        cloud = Pages([Result({"timeSeries": points[:1], "nextPageToken": "zeros"}), Result({"timeSeries": points[1:]})])
        cloud.json = lambda _args: Result([])
        value = self.pending_record()
        result = inventory(cloud, value, services=("pi-orb",), wall=lambda: "2026-09-09T12:00:00Z")
        self.assertIsNone(result.error)
        self.assertEqual(result.value["retirement"]["revisions"], [])
        self.assertEqual(result.value["retirement"]["excluded"], {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}})
        query = parse_qs(urlsplit(cloud.calls[0][1]).query)
        self.assertEqual(query["interval.startTime"], ["2026-09-09T11:45:00Z"])
        self.assertEqual(query["interval.endTime"], ["2026-09-09T12:00:00Z"])
        clock = [0]
        retired = wait_for_retirement(Pages([Result({})] * 13), value, services=("pi-orb",),
                                      wall=lambda: datetime.fromtimestamp(datetime(2026, 9, 9, 12, 3, tzinfo=timezone.utc).timestamp() + clock[0], timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
                                      monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds), limit=180)
        self.assertIsNone(retired.error)
        self.assertEqual(retired.value["retirement"]["excluded"], result.value["retirement"]["excluded"])
        self.assertTrue(retired.value['retirement']['resourcesRetired'])

    def test_deleted_revision_missing_either_zero_state_remains_unresolved(self):
        for state in ("active", "idle"):
            with self.subTest(state=state):
                cloud = Pages([
                    Result({"timeSeries": [series("pi-orb-deleted", state, "0", "2026-09-09T11:59:00Z")], "nextPageToken": "older"}),
                    Result({"timeSeries": [series("pi-orb-deleted", state, "1", "2026-09-09T11:58:00Z")]}),
                ])
                cloud.json = lambda _args: Result([])
                value = self.pending_record()
                result = inventory(cloud, value, services=("pi-orb",), wall=lambda: "2026-09-09T12:00:00Z")
                self.assertIsNone(result.error)
                self.assertEqual(result.value["retirement"]["revisions"], ["pi-orb-deleted"])
                missing = wait_for_retirement(Pages([Result({})]), value, services=("pi-orb",), wall=lambda: "2026-09-09T12:03:00Z", limit=0)
                self.assertEqual(missing.error.kind, "timeout")

    def test_positive_either_state_and_timestamp_ties_prevent_exclusion(self):
        for state in ("active", "idle"):
            for stamp in ("2026-09-09T11:59:00Z", "2026-09-09T12:00:00Z"):
                with self.subTest(state=state, stamp=stamp):
                    points = [series("pi-orb-deleted", item, "0", "2026-09-09T11:59:00Z") for item in ("active", "idle")]
                    points.append(series("pi-orb-deleted", state, "1", stamp))
                    cloud = Pages([Result({"timeSeries": points})])
                    cloud.json = lambda _args: Result([])
                    result = inventory(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:00:00Z")
                    self.assertEqual(result.value["retirement"]["revisions"], ["pi-orb-deleted"])

    def test_newly_discovered_positive_then_complete_or_incomplete_zeroes(self):
        for complete in (True, False):
            with self.subTest(complete=complete):
                value = self.pending_record()
                value["retirement"]["revisions"] = []
                points = [series("pi-orb-discovered", "active", "1", "2026-09-09T12:00:30Z")]
                points += zeroes("pi-orb-discovered") if complete else zeroes("pi-orb-discovered")[:1]
                result = evidence(value, points, "2026-09-09T12:02:00Z")
                self.assertEqual(result.value["revisions"], [] if complete else ["pi-orb-discovered"])
                self.assertEqual(result.value["zeroes"], {})
                self.assertEqual(set(result.value["excluded"]), {"pi-orb-discovered"} if complete else set())

    def test_excluded_preboundary_proof_cannot_retire_readmitted_target(self):
        for state in ("active", "idle"):
            with self.subTest(state=state):
                value = self.pending_record()
                value["retirement"]["revisions"] = []
                value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}}
                points = [series("pi-orb-deleted", state, "1", "2026-09-09T12:00:30Z"), series("pi-orb-deleted", state, "0")]
                result = evidence(value, points, "2026-09-09T12:02:00Z")
                self.assertEqual(result.value["revisions"], ["pi-orb-deleted"])
                self.assertEqual(result.value["excluded"], {})
                self.assertEqual(result.value["zeroes"], {})
                value["retirement"] = result.value
                proof = evidence(value, zeroes("pi-orb-deleted"), "2026-09-09T12:03:00Z")
                self.assertIn("pi-orb-deleted", proof.value["zeroes"])
                self.assertEqual(proof.value["excluded"], {})

    def test_saved_exclusion_retains_latest_explicit_zeroes(self):
        value = self.pending_record()
        value["retirement"]["revisions"] = []
        value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}}
        result = evidence(value, zeroes("pi-orb-deleted"), "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["excluded"]["pi-orb-deleted"], {"active": "2026-09-09T12:01:00Z", "idle": "2026-09-09T12:01:00Z"})

    def test_zero_only_and_unscoped_deleted_series_add_no_exclusion_noise(self):
        points = zeroes("pi-orb-zero-only")
        points += [series("pi-orb-wrong-region", "active", "1", region="elsewhere"),
                   series("pi-orb-wrong-service", "active", "1", service="unrelated")]
        cloud = Pages([Result({"timeSeries": points})])
        cloud.json = lambda _args: Result([])
        result = inventory(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["retirement"]["revisions"], [])
        self.assertEqual(result.value["retirement"]["excluded"], {})

    def test_invalid_or_conflicting_exclusion_evidence_fails_closed(self):
        for stamp in ("2026-02-30T11:59:00Z", "2026-09-09T12:03:00Z"):
            value = self.pending_record()
            value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": stamp, "idle": stamp}}
            self.assertIsNotNone(evidence(value, [], "2026-09-09T12:02:00Z").error)
        value = self.pending_record()
        value["retirement"]["excluded"] = {"pi-orb-old": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}}
        self.assertIsNotNone(evidence(value, [], "2026-09-09T12:02:00Z").error)

    def test_positive_tied_with_saved_exclusion_refutes_it(self):
        value = self.pending_record()
        value["retirement"]["revisions"] = []
        value["retirement"]["excluded"] = {"pi-orb-deleted": {"active": "2026-09-09T11:59:00Z", "idle": "2026-09-09T11:59:00Z"}}
        result = evidence(value, [series("pi-orb-deleted", "active", "1", "2026-09-09T11:59:00Z")], "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["revisions"], ["pi-orb-deleted"])
        self.assertEqual(result.value["excluded"], {})

    def test_surviving_revision_cannot_retire_with_preboundary_zeroes(self):
        points = [series("pi-orb-old", state, "0", "2026-09-09T11:59:00Z") for state in ("active", "idle")]
        value = self.pending_record()
        cloud = Pages([Result({"timeSeries": points})])
        cloud.json = lambda args: Result([] if args[0] == 'compute' else [{'metadata': {'name': 'pi-orb-old'}}])
        result = inventory(cloud, value, services=("pi-orb",), wall=lambda: "2026-09-09T12:00:00Z")
        self.assertEqual(result.value['retirement']['resources'], ['pi-orb-old'])
        self.assertFalse(result.value['retirement']['resourcesRetired'])
        blocked = wait_for_retirement(cloud, value, services=("pi-orb",), wall=lambda: '2026-09-09T12:02:00Z', limit=0)
        self.assertEqual(blocked.error.kind, 'conflict')

    def test_saved_postboundary_proof_survives_missing_series_and_later_positive_refutes_it(self):
        value = self.pending_record()
        value["retirement"] = evidence(value, zeroes(), "2026-09-09T12:02:00Z").value
        self.assertEqual(evidence(value, [], "2026-09-09T12:03:00Z").value["zeroes"], value["retirement"]["zeroes"])
        self.assertEqual(evidence(value, [series("pi-orb-old", "idle", "1", "2026-09-09T12:02:00Z")], "2026-09-09T12:03:00Z").value["zeroes"], {})

    def test_later_page_positive_refutes_first_page_proof(self):
        cloud = Pages([Result({"timeSeries": zeroes(), "nextPageToken": "later"}),
                       Result({"timeSeries": [series("pi-orb-old", "idle", "1", "2026-09-09T12:01:30Z")]})])
        checkpoints = []
        result = wait_for_retirement(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z",
                                     checkpoint=lambda value: (checkpoints.append(value["retirement"].copy()) or Result()), limit=0)
        self.assertEqual(result.error.kind, "timeout")
        self.assertEqual(checkpoints[-1]["zeroes"], {})
        self.assertEqual(len(cloud.calls), 2)

    def test_monitoring_fails_closed_on_error_in_later_service(self):
        class Cloud:
            def __init__(self): self.calls = []
            def http(self, method, url):
                self.calls.append(url)
                return fail("http", "Monitoring HTTP 400") if len(self.calls) == 4 else Result({})
        cloud = Cloud()
        result = metrics(cloud, "project", "us-central1", "start", "end", services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer"))
        self.assertEqual(result.error.kind, "http")
        self.assertEqual(len(cloud.calls), 4)

    def test_all_pages_are_required_even_after_a_zero_page(self):
        cloud = Pages([Result({"timeSeries": zeroes(), "nextPageToken": "next"}), fail("http", "unavailable")])
        self.assertIsNotNone(metrics(cloud, "project", "us-central1", "start", "end", services=("pi-orb", "pi-orb-ops", "pi-orb-runtime-api", "pi-orb-issuer")).error)
        self.assertEqual(len(cloud.calls), 2)
        self.assertIn("pageToken=next", cloud.calls[1][1])

    def test_repeated_and_invalid_page_tokens_fail_closed(self):
        for pages in ([Result({"nextPageToken": "same"}), Result({"nextPageToken": "same"})], [Result({"nextPageToken": None})]):
            self.assertIsNotNone(metrics(Pages(pages), "project", "region", "start", "end", services=("pi-orb",)).error)

    def test_deleted_but_live_revision_is_discovered(self):
        cloud = Pages([Result({"timeSeries": [series("pi-orb-deleted", "active", "1")]})])
        result = inventory(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z")
        self.assertEqual(result.value["retirement"]["revisions"], ["pi-orb-deleted"])
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
        result = wait_for_retirement(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
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
        cloud.json = lambda args: next(operations) if args[0] == 'compute' else Result([])
        result = wait_for_retirement(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=15)
        self.assertIsNone(result.error)
        self.assertEqual(clock[0], 15)
        self.assertEqual(result.value["retirement"]["operations"], [])

    def test_timeout_preserves_failure_instead_of_treating_elapsed_time_as_proof(self):
        clock = [0]
        cloud = Pages([Result({}), Result({})])
        result = wait_for_retirement(cloud, self.pending_record(), services=("pi-orb",), wall=lambda: "2026-09-09T12:02:00Z", monotonic=lambda: clock[0],
                                     sleep=lambda duration: clock.__setitem__(0, clock[0] + duration), limit=15)
        self.assertEqual(result.error.kind, "timeout")


if __name__ == "__main__":
    unittest.main()

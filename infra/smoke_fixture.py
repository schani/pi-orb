"""Smoke-only fixture publication IO; the publication transaction is single-shot."""
import os
import time

from infra.release_state import Cloud


class FixtureCloud(Cloud):
    def __init__(self):
        super().__init__()
        self.deadline = time.monotonic() + min(60, float(os.environ.get(
            "PI_ORB_SMOKE_DEADLINE", str(time.time() + 60))) - time.time())

    def http(self, method, url, body=None):
        return self.bounded_http(method, url, body, self.deadline,
                                 "fixture-get" if method == "GET" else "fixture-cas")

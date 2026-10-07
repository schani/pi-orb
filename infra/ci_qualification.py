#!/usr/bin/env python3
"""Exact-source GitHub qualification. Only first attempts qualify; never retry to green."""
from dataclasses import dataclass
import json
import http.client
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Literal

REPOSITORY = 'schani/pi-orb'
EXPECTED = {
    'ci.yml': ('CI', ('checks', 'control-plane-image')),
    'e2e.yml': ('E2E', tuple(f'E2E ({i}/4)' for i in range(1, 5))),
}


@dataclass(frozen=True)
class Failure:
    kind: Literal['invalid', 'http', 'timeout', 'pending']
    message: str


@dataclass(frozen=True)
class Result:
    value: object = None
    error: Failure | None = None


def fail(message, kind='invalid'):
    return Result(error=Failure(kind, message))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _url):
        return None


def positive_id(value):
    return type(value) is int and value > 0


def valid_evidence(value, sha):
    if not isinstance(value, dict) or set(value) != {'repository', 'sha', 'event', 'ref', 'runs'}:
        return False
    if (value['repository'] != REPOSITORY or value['sha'] != sha
            or not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha)
            or value['event'] != 'push' or value['ref'] != 'refs/heads/main'):
        return False
    runs = value['runs']
    if not isinstance(runs, list) or len(runs) != len(EXPECTED):
        return False
    ids = []
    for run, (path, (name, names)) in zip(runs, EXPECTED.items()):
        if not isinstance(run, dict) or set(run) != {'workflow', 'name', 'workflowId', 'runId', 'attempt', 'jobs'}:
            return False
        if (run['workflow'] != '.github/workflows/' + path or run['name'] != name
                or not positive_id(run['workflowId']) or not positive_id(run['runId'])
                or type(run['attempt']) is not int or run['attempt'] != 1):
            return False
        ids.append(run['runId'])
        jobs = run['jobs']
        if not isinstance(jobs, list) or len(jobs) != len(names):
            return False
        for job, expected_name in zip(jobs, sorted(names)):
            if (not isinstance(job, dict) or set(job) != {'id', 'name', 'conclusion'}
                    or not positive_id(job['id']) or job['name'] != expected_name or job['conclusion'] != 'success'):
                return False
        if len({job['id'] for job in jobs}) != len(jobs):
            return False
    return len(set(ids)) == len(ids)


class GitHub:
    def __init__(self, token):
        self.token = token

    def get(self, path):
        request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + path,
                                        headers={'Authorization': 'Bearer ' + self.token,
                                                 'Accept': 'application/vnd.github+json',
                                                 'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
                return Result(json.load(response))
        except urllib.error.HTTPError as error:
            return fail(f'GitHub API HTTP {error.code}; qualification unavailable', kind='http')
        except (OSError, ValueError, http.client.HTTPException):
            return fail('GitHub API unavailable or malformed response', kind='http')

    def listing(self, path, key):
        # Expected inventories are tiny. Refuse truncation rather than selecting
        # a success from a partial API page (or silently accepting missing shards).
        result = self.get(path + ('&' if '?' in path else '?') + 'per_page=100')
        if result.error:
            return result
        data = result.value
        if (not isinstance(data, dict) or not isinstance(data.get(key), list)
                or type(data.get('total_count')) is not int
                or data['total_count'] != len(data[key]) or data['total_count'] > 100
                or not all(isinstance(item, dict) for item in data[key])):
            return fail('GitHub API inventory incomplete or malformed')
        return Result(data[key])

    def list_runs(self, workflow, sha):
        query = urllib.parse.urlencode({'head_sha': sha, 'event': 'push', 'branch': 'main'})
        return self.listing(f'/actions/workflows/{workflow}/runs?{query}', 'workflow_runs')

    def list_jobs(self, run_id):
        return self.listing(f'/actions/runs/{run_id}/attempts/1/jobs', 'jobs')


def inspect(api, sha):
    runs = []
    pending = []
    for path, (name, names) in EXPECTED.items():
        listed = api.list_runs(path, sha)
        if listed.error:
            return listed
        if not listed.value:
            pending.append(f'{name}: missing push/main run for {sha}')
            continue
        if len(listed.value) != 1:
            return fail(f'{name}: multiple push/main runs for {sha}; refusing ambiguous qualification')
        run = listed.value[0]
        run_id = run.get('id')
        label = f'{name} run {run_id}' if positive_id(run_id) else name
        if (not positive_id(run_id) or not positive_id(run.get('workflow_id'))
                or run.get('name') != name or run.get('path') != '.github/workflows/' + path
                or run.get('event') != 'push' or run.get('head_branch') != 'main' or run.get('head_sha') != sha
                or not isinstance(run.get('repository'), dict) or run['repository'].get('full_name') != REPOSITORY
                or not isinstance(run.get('head_repository'), dict) or run['head_repository'].get('full_name') != REPOSITORY):
            return fail(f'{label}: untrusted workflow/source identity')
        if type(run.get('run_attempt')) is not int or run['run_attempt'] != 1:
            return fail(f'{label}: rerun rejected; diagnose the first attempt and qualify a new commit')
        if run.get('status') != 'completed':
            pending.append(f'{label}: not completed')
            continue
        if run.get('conclusion') != 'success':
            return fail(f'{label}: did not succeed; inspect https://github.com/{REPOSITORY}/actions/runs/{run_id}')
        jobs = api.list_jobs(run_id)
        if jobs.error:
            return jobs
        if (len(jobs.value) != len(names)
                or any(not isinstance(job.get('name'), str) for job in jobs.value)
                or {job.get('name') for job in jobs.value} != set(names)
                or any(job.get('status') != 'completed' or job.get('conclusion') != 'success'
                       or job.get('run_id') != run_id or job.get('run_attempt') != 1
                       or job.get('head_sha') != sha or not positive_id(job.get('id')) for job in jobs.value)):
            return fail(f'{label}: missing, unsuccessful, or foreign jobs; expected {", ".join(names)}')
        runs.append({'workflow': '.github/workflows/' + path, 'name': name,
                     'workflowId': run['workflow_id'], 'runId': run_id, 'attempt': 1,
                     'jobs': [{'id': job['id'], 'name': job['name'], 'conclusion': 'success'}
                              for job in sorted(jobs.value, key=lambda job: job['name'])]})
    if pending:
        return fail('; '.join(pending), kind='pending')
    evidence = {'repository': REPOSITORY, 'sha': sha, 'event': 'push', 'ref': 'refs/heads/main', 'runs': runs}
    return Result(evidence) if valid_evidence(evidence, sha) else fail('invalid qualification evidence')


def wait(api, sha, *, timeout=3600, clock=time.monotonic, sleep=time.sleep, log=lambda text: print(text, file=sys.stderr)):
    deadline = clock() + timeout
    previous = None
    while True:
        result = inspect(api, sha)
        if not result.error or result.error.kind != 'pending':
            return result
        if result.error != previous:
            log(result.error.message)
            previous = result.error
        remaining = deadline - clock()
        if remaining <= 0:
            return fail('qualification timeout: ' + result.error.message, kind='timeout')
        sleep(min(15, remaining))


def main(argv):
    mode = argv[1] if len(argv) == 2 else ''
    sha = os.environ.get('GITHUB_SHA', '')
    context = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': REPOSITORY,
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_WORKFLOW_REF': REPOSITORY + '/.github/workflows/deploy.yml@refs/heads/main'}
    if (mode not in ('wait', 'verify') or not re.fullmatch('[a-f0-9]{40}', sha)
            or any(os.environ.get(key) != value for key, value in context.items())
            or not os.environ.get('GH_TOKEN')):
        result = fail('invalid Deploy context or missing read-only GitHub token')
    else:
        api = GitHub(os.environ['GH_TOKEN'])
        result = wait(api, sha) if mode == 'wait' else inspect(api, sha)
        if mode == 'verify' and not result.error:
            try:
                expected = json.loads(os.environ.get('PI_ORB_CI_QUALIFICATION', ''))
            except ValueError:
                expected = None
            if not valid_evidence(expected, sha) or expected != result.value:
                result = fail('qualification handoff changed or invalid')
    if result.error:
        print('qualification: ' + result.error.message, file=sys.stderr)
        return 1
    print(json.dumps(result.value, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

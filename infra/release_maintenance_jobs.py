"""Bounded Cloud Run Job execution with private durable receipts, not log transport."""
import re
import time
from infra.release_state import Result, fail, utc_epoch


def wait_created(cloud, job, operation, checkpoint, *, monotonic=time.monotonic, sleep=time.sleep, limit=300):
    parent = job.rsplit('/jobs/', 1)[0]
    name = operation.get('name') if isinstance(operation, dict) else None
    if not isinstance(name, str) or not re.fullmatch(re.escape(parent) + r'/operations/[a-zA-Z0-9-]+', name):
        return fail('invalid', 'job creation operation is unknown')
    stored = checkpoint({'job': job, 'state': 'creating', 'operation': name})
    if stored.error:
        return stored
    deadline = monotonic() + limit
    while True:
        found = cloud.http('GET', f'https://run.googleapis.com/v2/{name}')
        if found.error:
            return found
        if not isinstance(found.value, dict):
            return fail('invalid', 'job creation status is unknown')
        if found.value.get('done') is True:
            if found.value.get('response', {}).get('name') != job or 'error' in found.value:
                return fail('conflict', 'job creation did not succeed')
            return Result()
        if monotonic() >= deadline:
            return fail('timeout', 'job creation remains uncertain; retain release lock')
        sleep(min(15, max(0, deadline - monotonic())))


def execute(cloud, job, checkpoint, *, monotonic=time.monotonic, sleep=time.sleep, limit=30 * 60):
    """Caller holds release lock until complete; never retry an uncertain run."""
    if not isinstance(job, str) or not re.fullmatch(r'projects/[a-z0-9-]+/locations/[a-z0-9-]+/jobs/pi-orb-(maint|migrate)-[a-z0-9-]+', job):
        return fail('invalid', 'job ownership is unknown')
    receipt = {'job': job, 'state': 'run-requested', 'operation': None, 'execution': None}
    stored = checkpoint(dict(receipt))
    if stored.error:
        return stored
    response = cloud.http('POST', f'https://run.googleapis.com/v2/{job}:run', {})
    if response.error:
        return response
    operation = response.value.get('name') if isinstance(response.value, dict) else None
    parent = job.rsplit('/jobs/', 1)[0]
    if not isinstance(operation, str) or not re.fullmatch(re.escape(parent) + r'/operations/[a-zA-Z0-9-]+', operation):
        return fail('invalid', 'job operation identity is unknown')
    receipt.update(state='running', operation=operation)
    stored = checkpoint(dict(receipt))
    if stored.error:
        return stored
    deadline = monotonic() + limit
    while True:
        observed = cloud.http('GET', f'https://run.googleapis.com/v2/{operation}')
        if observed.error:
            return observed
        value = observed.value
        if not isinstance(value, dict):
            return fail('invalid', 'job operation status is unknown')
        if value.get('done') is True:
            execution = value.get('response')
            if not isinstance(execution, dict) or not isinstance(execution.get('name'), str) or not execution['name'].startswith(job + '/executions/') or utc_epoch(execution.get('completionTime')) is None:
                return fail('invalid', 'job terminal execution is unknown')
            counts = {key: execution.get(key, 0) for key in ('succeededCount', 'failedCount', 'cancelledCount', 'taskCount')}
            if any(type(count) is not int or count < 0 for count in counts.values()):
                return fail('invalid', 'job terminal counts are unknown')
            # Project an allowlist: do not retain API responses with job env/secrets.
            receipt.update(state='terminal', execution={**counts, 'name': execution['name'], 'completionTime': execution['completionTime']})
            stored = checkpoint(dict(receipt))
            if stored.error:
                return stored
            if counts != {'succeededCount': 1, 'failedCount': 0, 'cancelledCount': 0, 'taskCount': 1}:
                return fail('conflict', 'job did not complete exactly one successful task')
            return Result(receipt)
        if monotonic() >= deadline:
            return fail('timeout', 'job execution remains uncertain; retain release lock and job')
        sleep(min(15, max(0, deadline - monotonic())))

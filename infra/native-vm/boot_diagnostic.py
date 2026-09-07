#!/usr/bin/python3
"""Publish a secret-free boot edge to the serial journal and durable GCE stores."""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
import urllib.request

ATTRIBUTE_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/pi-orb/boot-status'
INSTANCE_ID_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/id'
ZONE_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/zone'
PROJECT_ID_URL = 'http://metadata.google.internal/computeMetadata/v1/project/project-id'
TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
LOGGING_URL = 'https://logging.googleapis.com/v2/entries:write'
RUST_EVENT_CODES = ('rust_toolchain_retry', 'rust_toolchain_recovered')
RUST_ERROR_CLASSES = (
    'connection_refused', 'connection_reset', 'dns', 'http_429', 'http_5xx',
    'network_unreachable', 'timeout',
)


def filesystem_details():
    details = {}
    paths = [('bootFreeBytes', '/')]
    if os.path.ismount('/workspace'):
        paths.append(('workspaceFreeBytes', '/workspace'))
    for key, path in paths:
        try:
            value = os.statvfs(path)
            details[key] = value.f_bavail * value.f_frsize
        except OSError:
            pass
    return details


def payload(phase, status, code=None, message=None, details=None):
    record = {
        'schemaVersion': 1,
        'phase': phase,
        'status': status,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
    if code:
        record['code'] = code[:80]
    if message:
        record['message'] = message.replace('\n', ' ')[:500]
    bounded = {**filesystem_details(), **(details or {})}
    if bounded:
        record['details'] = bounded
    return record


def publish(record, urlopen=urllib.request.urlopen, write_attribute=True):
    record = dict(record)
    identity = {}
    try:
        for key, url in (('instanceId', INSTANCE_ID_URL), ('zone', ZONE_URL), ('projectId', PROJECT_ID_URL)):
            request = urllib.request.Request(url, headers={'Metadata-Flavor': 'Google'})
            with urlopen(request, timeout=5) as response:
                identity[key] = response.read().decode().strip().rsplit('/', 1)[-1]
        record.update(identity)
    except OSError:
        pass
    encoded = json.dumps(record, separators=(',', ':'), sort_keys=True)
    print(encoded, flush=True)
    if write_attribute:
        request = urllib.request.Request(ATTRIBUTE_URL, data=encoded.encode(), method='PUT', headers={'Metadata-Flavor': 'Google', 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=5):
                pass
        except OSError:
            pass
    try:
        token_request = urllib.request.Request(TOKEN_URL, headers={'Metadata-Flavor': 'Google'})
        with urlopen(token_request, timeout=5) as response:
            token = json.loads(response.read())['access_token']
        body = json.dumps({
            'logName': 'projects/' + identity['projectId'] + '/logs/pi-orb-boot',
            'resource': {'type': 'gce_instance', 'labels': {
                'project_id': identity['projectId'],
                'instance_id': identity['instanceId'],
                'zone': identity['zone'],
            }},
            'entries': [{'severity': 'ERROR' if record['status'] == 'failed' else 'INFO', 'jsonPayload': record}],
        }, separators=(',', ':')).encode()
        request = urllib.request.Request(LOGGING_URL, data=body, method='POST', headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        })
        with urlopen(request, timeout=10):
            pass
    except (OSError, KeyError, TypeError, ValueError):
        pass


def phase_for_unit(unit):
    if unit.startswith('pi-orb-workspace') or unit == 'workspace.mount':
        return 'workspace'
    if unit.startswith('pi-orb-bootstrap'):
        return 'bootstrap'
    if unit.startswith('pi-orb-runtime'):
        return 'runtime'
    return None


def has_exact_failure(urlopen=urllib.request.urlopen):
    request = urllib.request.Request(ATTRIBUTE_URL, headers={'Metadata-Flavor': 'Google'})
    try:
        with urlopen(request, timeout=5) as response:
            record = json.load(response)
        return record.get('schemaVersion') == 1 and record.get('status') == 'failed' and bool(record.get('code'))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def publish_unit_failure(unit, command=subprocess.run, urlopen=urllib.request.urlopen):
    phase = phase_for_unit(unit)
    if phase is None or not all(character.isalnum() or character in '_.@\\x-' for character in unit):
        return 2
    shown = command(
        ['/usr/bin/systemctl', 'show', unit, '--property=Result,NRestarts,ExecMainCode,ExecMainStatus'],
        capture_output=True, text=True, timeout=5, check=False,
    )
    details = {}
    for line in shown.stdout.splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('Result', 'NRestarts', 'ExecMainCode', 'ExecMainStatus'):
            details[key[0].lower() + key[1:]] = value[:80]
    code = phase + '_' + (details.get('result') or 'unit_failed').replace('-', '_')
    publish(payload(phase, 'failed', code, details=details), write_attribute=not has_exact_failure(urlopen))
    journal = command(
        ['/usr/bin/journalctl', '-b', '-u', unit, '--no-pager', '-n', '50'],
        capture_output=True, text=True, timeout=5, check=False,
    )
    publish(
        {**payload(phase, 'failed', code), 'kind': 'journal', 'unit': unit, 'journal': journal.stdout[-8000:]},
        write_attribute=False,
    )
    return 0


def rust_event(code, message, encoded_details):
    if code not in RUST_EVENT_CODES or message:
        return None
    try:
        details = json.loads(encoded_details)
    except (ValueError, TypeError):
        return None
    if not isinstance(details, dict) or isinstance(details.get('attempt'), bool):
        return None
    attempt = details.get('attempt')
    if not isinstance(attempt, int) or attempt not in (2, 3):
        return None
    if code == 'rust_toolchain_recovered':
        if set(details) != {'attempt'}:
            return None
    else:
        if set(details) != {'attempt', 'delayMs', 'errorClass'}:
            return None
        if details['delayMs'] not in (5_000, 15_000) or details['errorClass'] not in RUST_ERROR_CLASSES:
            return None
    return payload('runtime', 'event', code, details=details)


def main(arguments=sys.argv[1:]):
    if len(arguments) == 2 and arguments[0] == 'unit-failure':
        return publish_unit_failure(arguments[1])
    if len(arguments) == 5 and arguments[0:2] == ['runtime', 'event']:
        record = rust_event(arguments[2], arguments[3], arguments[4])
        if record is None:
            print('invalid runtime event', file=sys.stderr)
            return 2
        publish(record, write_attribute=False)
        return 0
    if len(arguments) < 2 or arguments[1] not in ('starting', 'ready', 'failed'):
        print('usage: pi-orb-boot-diagnostic PHASE STATUS [CODE] [MESSAGE]', file=sys.stderr)
        return 2
    phase = phase_for_unit(arguments[0]) or arguments[0]
    if phase not in ('workspace', 'bootstrap', 'runtime'):
        print('invalid diagnostic phase', file=sys.stderr)
        return 2
    if len(arguments) >= 3 and arguments[2] == 'unit_failed':
        arguments = [arguments[0], arguments[1], phase + '_unit_failed']
    details = None
    if len(arguments) >= 5:
        try:
            candidate = json.loads(arguments[4])
            if isinstance(candidate, dict):
                details = candidate
        except (ValueError, TypeError):
            pass
    publish(payload(phase, *arguments[1:4], details=details))
    return 0


if __name__ == '__main__':
    sys.exit(main())

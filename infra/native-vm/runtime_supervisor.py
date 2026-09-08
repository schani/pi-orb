#!/usr/bin/python3
"""Supervise the runtime and publish its structured readiness edge."""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

HEALTH_URL = 'http://127.0.0.1:8080/v1/health'
RUNTIME = ['/usr/local/bin/node', 'apps/orb-runtime/src/main.ts']
DIAGNOSTIC = '/usr/local/bin/pi-orb-boot-diagnostic'


def report(status, code=None, details=None):
    arguments = [DIAGNOSTIC, 'runtime', status]
    if code:
        arguments.append(code)
    if details:
        arguments.extend(['', json.dumps(details, separators=(',', ':'), sort_keys=True)])
    subprocess.run(arguments, check=False)


def health(urlopen=urllib.request.urlopen):
    request = urllib.request.Request(HEALTH_URL)
    with urlopen(request, timeout=2) as response:
        value = json.load(response)
    status = value.get('status') if isinstance(value, dict) else None
    if status == 'failed':
        error = value.get('error')
        code = error.get('code') if isinstance(error, dict) else None
        return status, code if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,80}', code) else 'runtime_failed'
    return status, None


def main(
    command=RUNTIME,
    health_check=health,
    sleep=time.sleep,
    popen=subprocess.Popen,
    install_signal=signal.signal,
    killpg=os.killpg,
):
    child = popen(command, start_new_session=True)

    def forward(signum, _frame):
        try:
            killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    install_signal(signal.SIGTERM, forward)
    install_signal(signal.SIGINT, forward)
    while child.poll() is None:
        try:
            status, code = health_check()
            if status == 'ready':
                report('ready')
                return child.wait()
            if status == 'failed':
                report('failed', code)
                return child.wait()
        except (OSError, ValueError, TypeError):
            pass
        sleep(1)
    returncode = child.returncode
    details = {'signal': -returncode} if returncode is not None and returncode < 0 else {'exitCode': returncode}
    report('failed', 'runtime_exited_before_ready', details)
    return child.wait()


if __name__ == '__main__':
    sys.exit(main())

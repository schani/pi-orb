"""Remove only unused Android tools on GitHub-hosted Ubuntu 24 runners."""
import os
import subprocess
from pathlib import Path


ANDROID = Path('/usr/local/lib/android')
HOST = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'ImageOS': 'ubuntu24', 'RUNNER_OS': 'Linux'}


def command(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True).stdout


def prepare(report):
    if ANDROID.resolve() != ANDROID:
        report('Refusing cleanup: Android path or ancestor is a symlink.')
        return 1
    if ANDROID.exists() and (not ANDROID.is_dir() or ANDROID.is_mount()
                            or ANDROID.stat().st_dev != ANDROID.parent.stat().st_dev):
        report('Refusing cleanup: Android root is not a directory on its parent filesystem.')
        return 1

    def snapshot(phase):
        report(f'### {phase}\n\n```')
        report('$ df -PB1 .\n' + command(['df', '-PB1', '.']).rstrip())
        if ANDROID.exists():
            report(f'$ du -sx -B1 -- {ANDROID}\n' +
                   command(['du', '-sx', '-B1', '--', str(ANDROID)]).rstrip())
        else:
            report(f'$ du -sx -B1 -- {ANDROID}\n0\t{ANDROID} (absent)')
        report('```\n')

    snapshot('Before')
    try:
        if ANDROID.exists():
            command(['rm', '-rf', '--one-file-system', '--', str(ANDROID)])
            if ANDROID.exists():
                report('Cleanup failed: Android root remains (possible nested filesystem).')
                return 1
    finally:
        snapshot('After')
    report('Android cleanup complete; downstream disk-budget guard remains authoritative.')
    return 0


def main():
    for key, expected in HOST.items():
        if os.environ.get(key) != expected:
            print(f'Refusing cleanup: requires {key}={expected}.', flush=True)
            return 1
    summary_path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not summary_path:
        print('Refusing cleanup: GITHUB_STEP_SUMMARY is required.', flush=True)
        return 1
    try:
        with Path(summary_path).open('a') as summary:
            def report(message):
                print(message, flush=True)
                summary.write(message + '\n')
                summary.flush()

            report('## Runner Android disk reclamation\n')
            try:
                return prepare(report)
            except (OSError, subprocess.CalledProcessError) as error:
                detail = error.output if isinstance(error, subprocess.CalledProcessError) else str(error)
                report(f'Cleanup failed: {error}\n{detail}')
                return 1
    except OSError as error:
        print(f'Cleanup failed: cannot write step summary: {error}', flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

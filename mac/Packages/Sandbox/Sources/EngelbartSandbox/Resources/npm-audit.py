"""Bounded, read-only npm audits after preview readiness; never runs audit fix."""
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT = Path('/home/user/repository')
IGNORE = {'.git', 'node_modules', '.venv', 'venv', 'vendor', '.next', 'dist', 'build'}
SEVERITIES = ('info', 'low', 'moderate', 'high', 'critical')


def emit(status, message, **details):
    print(json.dumps({'phase': 'audit', 'status': status, 'message': message, **details}), flush=True)


def projects():
    found, truncated, visited = [], False, 0
    for directory, children, files in os.walk(ROOT, followlinks=False):
        root = Path(directory)
        children[:] = sorted(name for name in children if name not in IGNORE and not (root / name).is_symlink())
        visited += 1
        if visited > 200:
            truncated = True
            break
        if len(root.relative_to(ROOT).parts) >= 5 and children:
            children[:] = []
            truncated = True
        locks = [name for name in ('package-lock.json', 'npm-shrinkwrap.json') if name in files]
        if ('package.json' not in files or not locks or not (root / 'node_modules').is_dir() or
                (root / 'node_modules').is_symlink() or
                any((root / name).is_symlink() for name in ['package.json', *locks]) or
                any(name in files for name in ('pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'))):
            continue
        try:
            if (root / 'package.json').stat().st_size > 64000:
                continue
            package = json.loads((root / 'package.json').read_text())
            if not isinstance(package, dict) or not str(package.get('packageManager', 'npm')).startswith('npm'):
                continue
        except (OSError, ValueError):
            continue
        if len(found) == 10:
            truncated = True
            break
        found.append(root)
        if package.get('workspaces'):
            children[:] = []  # audit the shared lockfile once, not per workspace
    return found, truncated


def summarize(report, code):
    counts = report.get('metadata', {}).get('vulnerabilities', {})
    if (code not in (0, 1) or report.get('error') or
            any(type(counts.get(key)) is not int or counts[key] < 0 for key in (*SEVERITIES, 'total'))):
        raise ValueError('npm did not return a complete vulnerability report')
    total = counts['total']
    if total != sum(counts[key] for key in SEVERITIES):
        raise ValueError('Inconsistent vulnerability counts')
    # Exit 1 with findings is normal npm audit behavior, not an audit failure.
    if code != 0 and total == 0:
        raise ValueError('npm audit exited without a usable report')
    counts = {key: counts[key] for key in (*SEVERITIES, 'total')}
    names = []
    for name, item in (report.get('vulnerabilities') or {}).items():
        if isinstance(item, dict) and item.get('severity') in SEVERITIES:
            names.append((SEVERITIES.index(item['severity']), str(name)[:160], item['severity']))
    names.sort(reverse=True)
    summary = ', '.join(f'{counts[key]} {key}' for key in reversed(SEVERITIES) if counts[key])
    message = f'{total} vulnerabilities ({summary})' if total else 'No known vulnerabilities reported'
    if names:
        message += '. Affected packages: ' + ', '.join(f'{name} ({severity})' for _, name, severity in names[:10])
        if len(names) > 10:
            message += f', +{len(names) - 10} more'
    return {'status': 'findings' if total else 'complete', 'message': message, 'vulnerabilities': counts}


def audit(root, timeout):
    # npm audit does not execute installation scripts or modify the lockfile.
    # Temporary output files bound memory even if the registry returns a huge report.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(['npm', 'audit', '--json', '--audit=true'], cwd=root,
                                   env={**os.environ, 'npm_config_audit': 'true',
                                        'npm_config_fetch_retries': '0', 'npm_config_fetch_timeout': '20000'},
                                   stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
            if stdout.tell() > 2000000:
                raise ValueError('report exceeded the size limit')
            stdout.seek(0)
            return summarize(json.load(stdout), code)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def main():
    deadline = time.monotonic() + 90
    roots, truncated = projects()
    if not roots:
        emit('skipped', 'npm audit: no installed npm lockfile project found.')
    for root in roots:
        cwd = str(root.relative_to(ROOT))
        remaining = deadline - time.monotonic()
        if remaining < 1:
            emit('unavailable', f'npm audit ({cwd}): not checked; background audit time limit reached.', cwd=cwd)
            continue
        emit('checking', f'npm audit ({cwd}): checking dependencies after preview readiness.', cwd=cwd)
        try:
            result = audit(root, min(30, remaining))
            emit(result.pop('status'), f"npm audit ({cwd}): {result.pop('message')}. No dependencies changed.", cwd=cwd, **result)
        except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
            # Do not echo raw registry/error responses, which can contain tokens.
            emit('unavailable', f'npm audit ({cwd}): report unavailable or timed out; dependencies were not changed.', cwd=cwd)
    if truncated:
        emit('unavailable', 'npm audit: repository scan limit reached; some directories were not checked.')


if __name__ == '__main__':
    main()

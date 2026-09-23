"""Read-only repo preflight and owned dependency-install process control in E2B."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from launch import ROOT, STATE, process_snapshot

LOCKS = {'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm',
         'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun'}
IGNORE = {'.git', 'node_modules', '.venv', 'venv', 'vendor', '.next', 'dist', 'build'}


def inside(value):
    target = (ROOT / value).resolve()
    if not target.is_relative_to(ROOT.resolve()):
        raise ValueError('Path must be inside the sandbox repository')
    return target


def listing(value):
    target = inside(value)
    entries = []
    with os.scandir(target) as children:
        for child in children:
            if child.name in IGNORE:
                continue
            entries.append({'name': child.name, 'type': 'symlink' if child.is_symlink() else
                            'directory' if child.is_dir(follow_symlinks=False) else 'file'})
            if len(entries) > 200:
                break
    return {'path': str(target), 'entries': sorted(entries[:200], key=lambda e: e['name']),
            'truncated': len(entries) > 200}


def version(command):
    try:
        result = subprocess.run([command, '--version'], cwd='/tmp', capture_output=True,
                                text=True, timeout=5, check=True)
        value = result.stdout.strip()
        return value if re.fullmatch(r'v?\d+\.\d+\.\d+', value) else None
    except (OSError, subprocess.SubprocessError):
        return None


def inspect():
    facts = {'files': listing('.'), 'lockfiles': [name for name in LOCKS if (ROOT / name).exists()],
             'nestedManifests': [], 'runtimeFiles': {}, 'versions': {}, 'customFiles': []}
    if any((ROOT / name).is_symlink() for name in facts['lockfiles']):
        raise ValueError('Linked lockfiles need agent inspection')
    manifest = ROOT / 'package.json'
    if not manifest.exists():
        return facts
    if manifest.is_symlink() or manifest.stat().st_size > 64000:
        raise ValueError('The root manifest needs agent inspection')
    package = json.loads(manifest.read_text())
    if not isinstance(package, dict):
        raise ValueError('Invalid package manifest')
    facts['package'] = {key: package[key] for key in
                        ('name', 'packageManager', 'engines', 'scripts', 'workspaces', 'volta', 'devEngines')
                        if key in package}
    for name in ('.nvmrc', '.node-version'):
        file = ROOT / name
        if file.exists():
            if file.is_symlink() or file.stat().st_size > 2000:
                raise ValueError('The runtime declaration needs agent inspection')
            facts['runtimeFiles'][name] = file.read_text().strip()
    for name in ('.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.tool-versions', 'binding.gyp'):
        if (ROOT / name).exists():
            facts['customFiles'].append(name)
    # Deliberately bounded: an incomplete/ambiguous scan is handed to Claude.
    visited = 0
    for directory, children, files in os.walk(ROOT, followlinks=False):
        children[:] = sorted(name for name in children if name not in IGNORE and
                             not (Path(directory) / name).is_symlink())
        relative = Path(directory).relative_to(ROOT)
        if len(relative.parts) >= 2:
            children[:] = []
        visited += 1
        if visited > 100:
            facts['scanTruncated'] = True
            break
        if relative.parts and 'package.json' in files:
            facts['nestedManifests'].append(str(relative / 'package.json'))
    facts['versions']['node'] = version('node')
    managers = {LOCKS[name] for name in facts['lockfiles']}
    if len(managers) == 1:
        manager = next(iter(managers))
        facts['versions'][manager] = version(manager)
    return facts


def marked(job_id):
    snapshot = process_snapshot()
    roots = set()
    marker = f'ENGELBART_CANVAS_INSTALL_JOB={job_id}'.encode()
    for pid in snapshot:
        try:
            if marker in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
                roots.add(pid)
        except FileNotFoundError:
            pass
        except PermissionError:
            # Unrelated system processes can belong to another user.
            pass
    while True:
        children = {pid for pid, (parent, _, _) in snapshot.items() if parent in roots}
        if children <= roots:
            break
        roots |= children
    return {pid: snapshot[pid] for pid in roots}


def stop(job_id):
    # Fence off a delayed launch before checking processes. A disconnected SDK
    # request is NOT proof that its remote package manager stopped.
    (STATE / f'install-{job_id}.cancel').touch(mode=0o600)
    tracked = {}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for _ in range(20):
            # Remember observed children even if their parent exits and they
            # clear their inherited environment or are reparented afterwards.
            tracked.update(marked(job_id))
            snapshot = process_snapshot()
            victims = {pid: value for pid, value in tracked.items()
                       if pid in snapshot and snapshot[pid][1] == value[1]}
            if not victims:
                return
            for pid, original in victims.items():
                current = process_snapshot().get(pid)
                if current and current[1] == original[1]:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            time.sleep(0.05)
    snapshot = process_snapshot()
    if marked(job_id) or any(pid in snapshot and snapshot[pid][1] == value[1]
                             for pid, value in tracked.items()):
        raise RuntimeError('Could not confirm the dependency install stopped; no replacement was started')


def run(job_id):
    if (STATE / f'install-{job_id}.cancel').exists():
        return 130
    spec = json.loads((STATE / f'install-{job_id}.json').read_text())
    cwd = inside(spec['cwd'])
    command = spec['command']
    if not isinstance(command, str) or not command.strip() or len(command) > 8000 or '\0' in command:
        raise ValueError('Invalid dependency install command')
    # Keep the shell in the SDK-owned tree; all descendants inherit the job tag.
    return subprocess.call(['bash', '-c', command], cwd=cwd, stdin=subprocess.DEVNULL)


def main():
    action, *args = sys.argv[1:]
    if action == 'inspect':
        print(json.dumps(inspect()))
    elif action == 'list':
        print(json.dumps(listing(args[0])))
    elif action in ('run', 'stop'):
        job_id = args[0]
        if not re.fullmatch(r'[a-f0-9-]{36}', job_id):
            raise ValueError('Invalid install job')
        if action == 'run':
            return run(job_id)
        stop(job_id)
    else:
        raise ValueError('Unknown install operation')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

"""Read-only repo preflight and owned dependency-install process control in E2B."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
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


def inspect(value='.'):
    root = inside(value)
    facts = {'files': listing(value), 'lockfiles': [name for name in LOCKS if (root / name).exists()],
             'nestedManifests': [], 'runtimeFiles': {}, 'versions': {}, 'customFiles': []}
    if any((root / name).is_symlink() for name in facts['lockfiles']):
        raise ValueError('Linked lockfiles need agent inspection')
    manifest = root / 'package.json'
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
        file = root / name
        if file.exists():
            if file.is_symlink() or file.stat().st_size > 2000:
                raise ValueError('The runtime declaration needs agent inspection')
            facts['runtimeFiles'][name] = file.read_text().strip()
    for name in ('.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.tool-versions', 'binding.gyp'):
        if (root / name).exists():
            facts['customFiles'].append(name)
    # Deliberately bounded: an incomplete/ambiguous scan is handed to Claude.
    visited = 0
    for directory, children, files in os.walk(root, followlinks=False):
        children[:] = sorted(name for name in children if name not in IGNORE and
                             not (Path(directory) / name).is_symlink())
        relative = Path(directory).relative_to(root)
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


def parallel_plan(spec):
    """Only independent npm + requirements.txt roots; ambiguous layouts stay agent-led."""
    targets = spec.get('parallel')
    if (set(spec) != {'parallel'} or not isinstance(targets, list) or len(targets) != 2 or
            any(not isinstance(t, dict) or set(t) != {'manager', 'cwd'} or
                not isinstance(t['cwd'], str) for t in targets) or
            sorted(t['manager'] for t in targets) != ['npm', 'pip']):
        raise ValueError('Parallel installation requires one npm and one pip directory')
    roots = [inside(t['cwd']) for t in targets]
    if roots[0].is_relative_to(roots[1]) or roots[1].is_relative_to(roots[0]):
        raise ValueError('Parallel install directories must not overlap')
    shared = {'package.json', *LOCKS, '.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml',
              '.nvmrc', '.node-version', '.tool-versions', 'requirements.txt', 'pyproject.toml',
              'setup.py', 'setup.cfg', 'Pipfile', 'poetry.lock', 'uv.lock'}
    for root in roots:
        if not root.is_dir() or any(part in IGNORE for part in root.relative_to(ROOT.resolve()).parts):
            raise ValueError('Invalid parallel install directory')
        parent = root.parent
        while parent.is_relative_to(ROOT.resolve()):
            if any((parent / name).exists() for name in shared):
                raise ValueError('Shared parent manifests/configuration need sequential agent inspection')
            parent = parent.parent

    def read_file(root, name, limit=64000):
        file = root / name
        if file.is_symlink() or file.stat().st_size > limit:
            raise ValueError('Linked or oversized install input needs agent inspection')
        return file.read_text()

    tasks, npm_facts = [], None
    for target, root in zip(targets, roots):
        manager = target['manager']
        if manager == 'npm':
            npm_facts = inspect(str(root))
            if len(npm_facts['lockfiles']) != 1 or LOCKS[npm_facts['lockfiles'][0]] != 'npm':
                raise ValueError('Parallel npm installation needs one npm lockfile')
            package = json.loads(read_file(root, 'package.json'))
            for key in ('dependencies', 'devDependencies', 'optionalDependencies'):
                for value in package.get(key, {}).values():
                    if not isinstance(value, str) or re.search(r'file:|link:|workspace:|[/\\]|git:', value):
                        raise ValueError('Linked/local dependencies need sequential agent inspection')
            lock = json.loads(read_file(root, npm_facts['lockfiles'][0], 4000000))
            # Covers workspace/link entries as well as transitive local dependencies.
            if re.search(r'"link"\s*:\s*true|"(?:resolved|version)"\s*:\s*"(?:file:|link:|workspace:)', json.dumps(lock)):
                raise ValueError('Linked lockfile dependencies need sequential agent inspection')
            command = 'npm ci --no-audit'
        else:
            if any((root / name).exists() for name in shared - {'requirements.txt'}):
                raise ValueError('Custom Python setup needs sequential agent inspection')
            if (root / '.venv').exists() or (root / '.venv').is_symlink():
                raise ValueError('An existing Python environment needs agent inspection')
            requirements = read_file(root, 'requirements.txt')
            for line in requirements.splitlines():
                line = line.split('#', 1)[0].strip()
                if line and (not re.match(r'^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*[<>=!~;]|\s*$)', line) or
                             any(char in line for char in ('/', '\\', '@', '$', ':'))):
                    raise ValueError('Local/editable/included Python requirements need sequential agent inspection')
            command = 'python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt'
        tasks.append({'manager': manager, 'cwd': str(root), 'command': command})
    return {'tasks': tasks, 'npmFacts': npm_facts}


def run_parallel(tasks):
    # One owned job, two children. Every descendant inherits the same job marker,
    # so stop/replacement retains the existing confirmed process-tree cleanup.
    children, threads = [], []
    output_lock = threading.Lock()

    def output(label, text):
        with output_lock:
            print(f'[{label}] {text.rstrip()}', flush=True)

    def drain(process, label):
        with process.stdout:
            while True:
                line = process.stdout.readline(2000)
                if not line:
                    break
                output(label, line)

    try:
        for task in tasks:
            label = f"{task['manager']} {Path(task['cwd']).relative_to(ROOT.resolve())}"
            output(label, f"Starting: {task['command']}")
            process = subprocess.Popen(['bash', '-c', task['command']], cwd=task['cwd'],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, errors='replace')
            children.append((process, label))
            thread = threading.Thread(target=drain, args=(process, label), daemon=True)
            thread.start()
            threads.append(thread)
        outcomes = []
        for process, label in children:
            code = process.wait()
            outcomes.append(code)
            output(label, f'Finished (exit {code})')
        for thread in threads:
            thread.join(timeout=2)
        return 0 if all(code == 0 for code in outcomes) else 1
    finally:
        # On exceptional launch/wait failure the JS owner also confirms cleanup
        # of all descendants before it can mark the job finished or replace it.
        for process, _ in children:
            if process.poll() is None:
                process.terminate()


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
    if 'parallel' in spec:
        return run_parallel(parallel_plan(spec)['tasks'])
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
    elif action in ('run', 'stop', 'plan'):
        job_id = args[0]
        if not re.fullmatch(r'[a-f0-9-]{36}', job_id):
            raise ValueError('Invalid install job')
        if action == 'run':
            return run(job_id)
        if action == 'plan':
            print(json.dumps(parallel_plan(json.loads((STATE / f'install-{job_id}.json').read_text()))))
        else:
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

"""Canvas adapter installed into an existing E2B sandbox, not its template.

Reuses hc's saved launch plan, but never replays installation on an env restart.
The repository is disposable code; the payload and recipe stay outside it.
"""
import importlib.util
import fcntl
import contextlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/home/user/repository')
STATE = Path('/home/user/.engelbart-canvas')
WRAPPER = '/opt/engelbart/hc_run.py'
ACTIVE_RUNS = {'installing', 'building', 'starting', 'running', 'setup_planning', 'setup_running', 'awaiting_approval'}
STEP = 'loading the launcher'


class RestartBlocked(RuntimeError):
    """A safe, actionable handoff error (never contains application values)."""


def write_private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def load_wrapper():
    spec = importlib.util.spec_from_file_location('canvas_hc', WRAPPER)
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    return wrapper


def recipe_for(wrapper, PR, port):
    recipe = read_json(STATE / 'recipe.json', None)
    if recipe:
        return recipe
    # Compatibility with sandboxes built before this adapter was installed.
    for file in sorted(PR.folder().glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        record = read_json(file, {})
        if Path(record.get('repositoryRoot', record.get('cwd', '/'))) != ROOT:
            continue
        recipe = wrapper.capture(PR, file.stem)
        if recipe:
            return recipe
    if (ROOT / wrapper.SETUP_DIR / 'start.sh').is_file() and port:
        return {'kind': 'setup', 'startUrl': f'http://127.0.0.1:{int(port)}'}
    raise ValueError('This sandbox has no reusable launch plan. Its running app was left untouched.')


def prune_saved(folder, names):
    # hc.save merges; explicitly remove our managed keys, including deleted ones.
    # Keep unrelated auto-generated service values (e.g. local Supabase).
    for file in folder.glob('*.json'):
        if file.is_symlink():
            raise ValueError('Refusing a symlink in environment storage')
        previous = read_json(file, {})
        kept = {k: v for k, v in previous.items() if k not in names}
        if kept != previous:
            write_private(file, kept)


def install_environment(wrapper, PE, PR, values, removed):
    previous = set(read_json(STATE / 'managed.json', []))
    managed = previous | set(values) | set(removed)
    folder, _ = PE.storage(ROOT)
    prune_saved(folder, managed)
    write_private(STATE / 'managed.json', sorted(managed))
    # Do not copy user overrides back into hc's merge-only persistent store.
    wrapper.load_env = lambda: values
    wrapper.hand_over = lambda _pe, _dirs, provided: (provided, [])
    scan = PE.scan

    def scan_with_overrides(*args, **kwargs):
        report = scan(*args, **kwargs)
        for row in report.get('variables', []):
            if row['name'] in values:
                row.update(status='found', source='Engelbart local storage')
            elif row['name'] in removed:
                row.update(status='missing', source=None)
        return report

    PE.scan = scan_with_overrides
    original = PR.environment

    def environment(cwd, inherited_values=None, validate_required=True, skipped=None):
        inherited = {k: v for k, v in (inherited_values or {}).items() if k not in managed}
        base, selected, old_redact = original(cwd, inherited, validate_required, skipped)
        for name in removed:
            base.pop(name, None)
            selected.pop(name, None)
        base.update(values)
        selected.update(values)
        secrets = sorted({v for v in selected.values() if v}, key=len, reverse=True)

        def mask(text):
            for secret in secrets:
                text = str(text).replace(secret, '[redacted]')
            return old_redact(text)
        return base, selected, mask

    PR.environment = environment
    # The fallback shell launcher bypasses PR.environment. Apply only around
    # app scripts, never to the setup agent's own credential environment.
    for name in ('run_script', 'start_app'):
        original_script = getattr(wrapper, name)

        def script(*args, _call=original_script, **kwargs):
            before = dict(os.environ)
            try:
                for key in ('ANTHROPIC_API_KEY', 'E2B_API_KEY', *removed):
                    os.environ.pop(key, None)
                os.environ.update(values)
                return _call(*args, **kwargs)
            finally:
                os.environ.clear()
                os.environ.update(before)
        setattr(wrapper, name, script)


def process_snapshot():
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            stat = (entry / 'stat').read_text().split(') ', 1)[1].split()
            if stat[0] == 'Z':
                continue  # A zombie no longer runs code or owns a listener.
            command = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            processes[int(entry.name)] = (int(stat[1]), stat[19], command)
        except (OSError, IndexError):
            continue
    return processes


@contextlib.contextmanager
def app_lock():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(os.open(STATE / 'app.lock', os.O_CREAT | os.O_RDWR, 0o600), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def app_owned(record, processes=None):
    """An inherited attempt tag plus saved PID/start times survives reparenting."""
    processes = process_snapshot() if processes is None else processes
    marker = f"ENGELBART_CANVAS_APP_ATTEMPT={record['attempt_id']}".encode()
    owned = {int(pid) for pid, born in record.get('members', {}).items()
             if int(pid) in processes and processes[int(pid)][1] == born}
    for pid in processes:
        try:
            if marker in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
                owned.add(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    while True:
        children = {pid for pid, (parent, _, _) in processes.items() if parent in owned}
        if children <= owned:
            break
        owned |= children
    return {pid: processes[pid] for pid in owned}


def app_listeners(processes, owned, port):
    """Read Linux socket ownership without depending on lsof/ss or printing argv."""
    sockets = {}
    for family, file in ((socket.AF_INET, '/proc/net/tcp'), (socket.AF_INET6, '/proc/net/tcp6')):
        try:
            lines = Path(file).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            address, number = fields[1].split(':')
            packed = b''.join(struct.pack('=I', int(address[i:i + 8], 16)) for i in range(0, len(address), 8))
            sockets[fields[9]] = {'address': socket.inet_ntop(family, packed), 'port': int(number, 16), 'pids': []}
    for pid in processes:
        try:
            for fd in Path(f'/proc/{pid}/fd').iterdir():
                try:
                    target = os.readlink(fd)
                    if target.startswith('socket:[') and target[8:-1] in sockets:
                        sockets[target[8:-1]]['pids'].append(pid)
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    pass
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    result = []
    for row in sockets.values():
        row['pids'] = sorted(set(row['pids']))
        row['ownership'] = 'owned' if row['pids'] and all(pid in owned for pid in row['pids']) else 'unowned' if row['pids'] else 'unknown'
        if row['port'] == port or any(pid in owned for pid in row['pids']):
            result.append(row)
    return sorted(result, key=lambda row: (row['port'], row['address']))


def app_health(listeners, port, route):
    targets = []
    for row in listeners:
        if row['port'] == port and row['ownership'] == 'owned':
            host = {'0.0.0.0': '127.0.0.1', '127.0.0.1': '127.0.0.1', '::': '::1', '::1': '::1'}.get(row['address'])
            if host and host not in targets:
                targets.append(host)
    checks = []
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for host in targets:
        url = f"http://{'[' + host + ']' if ':' in host else host}:{port}{route}"
        check = {'url': url, 'host': host, 'ok': False}
        try:
            with client.open(url, timeout=1) as response:
                check.update(http_status=response.status, ok=200 <= response.status < 400)
        except urllib.error.HTTPError as error:
            check['http_status'] = error.code
        except (OSError, urllib.error.URLError):
            check['error'] = 'Connection refused, timed out, or closed before an HTTP response'
        checks.append(check)
        if check['ok']:
            return {**check, 'checks': checks}
    return {'ok': False, 'checks': checks, 'error': 'No owned loopback listener on the requested port' if not targets else 'The application did not return a successful HTTP response'}


def app_status(record=None, probe=True, port=None):
    record = read_json(STATE / 'app.json', None) if record is None else record
    if not record:
        listeners = app_listeners(process_snapshot(), {}, port) if port else []
        return {'status': 'idle', 'running': False, 'processes': [], 'listeners': listeners[:64], 'health': None, 'output': '', 'checked_at': time.time()}
    processes = process_snapshot()
    owned = app_owned(record, processes)
    listeners = app_listeners(processes, owned, port or record['port'])
    health = app_health(listeners, record['port'], record.get('path', '/')) if probe and owned else record.get('health')
    status = record['status']
    if owned and probe:
        status = 'healthy' if health and health['ok'] else 'unhealthy'
    elif not owned and status in ('healthy', 'unhealthy'):
        status = 'exited'
    return {'attempt_id': record['attempt_id'], 'status': status, 'running': bool(owned),
            'port': record['port'], 'processes': [{'pid': pid, 'parent_pid': row[0], 'name': Path(row[2].split(' ', 1)[0]).name} for pid, row in sorted(owned.items())][:64],
            'process_count': len(owned), 'listeners': listeners[:64], 'health': {**health, 'current': bool(probe and owned)} if health else None,
            'error': record.get('error'), 'output': record.get('output', '')[-4000:],
            'checked_at': time.time(), 'truncated': len(owned) > 64 or len(listeners) > 64}


def stop_owned_app(attempt_id=None):
    """Fence delayed starts and confirm owned descendants stopped, even after their supervisor died."""
    with app_lock():
        record = read_json(STATE / 'app.json', None)
        target = attempt_id or (record and record['attempt_id'])
        if not target:
            return
        if not re.fullmatch(r'[a-f0-9-]{36}', target):
            raise RestartBlocked('Invalid application attempt')
        (STATE / f'app-{target}.cancel').touch(mode=0o600)
        if not record or record['attempt_id'] != target:
            return
        tracked = dict(record.get('members', {}))
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for _ in range(20):
                owned = app_owned({**record, 'members': tracked})
                tracked.update({str(pid): row[1] for pid, row in owned.items()})
                record['members'] = tracked
                write_private(STATE / 'app.json', record)
                if not owned:
                    record.update(status='stopped', members=tracked)
                    write_private(STATE / 'app.json', record)
                    return
                for pid, row in owned.items():
                    current = process_snapshot().get(pid)
                    if current and current[1] == row[1]:
                        try:
                            os.kill(pid, sig)
                        except ProcessLookupError:
                            pass
                time.sleep(0.05)
        raise RestartBlocked('Could not confirm the owned application stopped. No replacement was started.')


def launcher_roots(processes, local_tools=False):
    roots = {pid for pid, (_, _, command) in processes.items() if
             WRAPPER in command or '/opt/engelbart/proxy.mjs' in command or
             (str(STATE / 'launch.py') in command and not any(flag in command for flag in ('--stop', '--check', '--app-status')))}
    if local_tools:
        # E2B request cancellation can disconnect without killing the command.
        # Include only our marked tool processes, not unrelated VM services.
        for pid in processes:
            try:
                if b'ENGELBART_CANVAS_LOCAL_TOOL=1' in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
                    roots.add(pid)
            except OSError:
                pass  # Exited processes or inaccessible system-owned services.
    return roots


def retire_launch_records(processes):
    # hc refuses a second launch while an on-disk record is still active, even
    # when its old supervisor has exited. Only retire this repository's records,
    # AFTER stop_launch has confirmed the old process tree is no longer running.
    folder = Path(os.environ.get('HUMAN_COMPACT_HOME', '/home/user/.human-compact')) / 'project-runs'
    records = []
    for file in folder.glob('*.json'):
        if not re.fullmatch(r'[a-f0-9]{32}\.json', file.name):
            continue
        if file.is_symlink():
            raise RestartBlocked('Cannot safely update a symlinked launch record. The replacement app was not started.')
        record = read_json(file, {})
        cwd = Path(record.get('cwd', '/')).resolve()
        root = Path(record.get('repositoryRoot', cwd)).resolve()
        if not cwd.is_relative_to(ROOT.resolve()) or not root.is_relative_to(ROOT.resolve()):
            continue
        run = record.get('run') or {}
        if run.get('status') not in ACTIVE_RUNS:
            continue
        pid = run.get('pid')
        if pid in processes:
            try:
                if Path(os.readlink(f'/proc/{pid}/cwd')).resolve().is_relative_to(ROOT.resolve()):
                    raise RestartBlocked('The previous application is still running. No replacement was started; retry the restart.')
            except OSError:
                pass
        records.append((file, record))
    for file, record in records:
        record['run'].update(status='stopped', healthy=False, pid=None, url=None,
                             reason='Stopped by Canvas before restarting the application')
        write_private(file, record)  # Preserve the plan, attempts, and logs.


def stop_launch(local_tools=False):
    # Stop the wrapper and its descendants, including services that do not own
    # the entry port. Docker/local databases outside that tree are preserved.
    stop_owned_app()
    processes = process_snapshot()
    victims = launcher_roots(processes, local_tools)
    while True:
        children = {pid for pid, (parent, _, _) in processes.items() if parent in victims}
        if children <= victims:
            break
        victims |= children
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in victims:
            try:
                # PID reuse cannot turn a saved target into some other process.
                current = process_snapshot().get(pid)
                if current and current[1] == processes[pid][1]:
                    os.kill(pid, sig)
            except OSError:
                pass
        for _ in range(20):
            current = process_snapshot()
            live = {pid for pid in victims if pid in current and current[pid][1] == processes[pid][1]}
            if not live and not launcher_roots(current, local_tools):
                retire_launch_records(current)
                return
            time.sleep(0.05)
    raise RestartBlocked('Could not confirm the previous application stopped. No replacement was started; retry the restart.')


def local_recipe(recipe):
    cwd = Path(recipe.get('cwd', str(ROOT))).resolve()
    port = recipe.get('port')
    command = recipe.get('command')
    route = recipe.get('path', '/')
    if (not cwd.is_relative_to(ROOT.resolve()) or not cwd.is_dir()
            or not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535 or port == 43110
            or not isinstance(command, str) or not command.strip() or len(command) > 8000 or '\0' in command
            or not isinstance(route, str) or not route.startswith('/') or route.startswith('//')
            or any(c in route for c in ('\r', '\n', '\\'))):
        raise ValueError('Invalid local Claude launch plan')
    return cwd, command, port, route


def launch_local(recipe, attempt_id=None):
    # No hc imports or model calls: this is also the subscription-mode restart.
    cwd, command, port, route = local_recipe(recipe)
    attempt_id = attempt_id or str(uuid.uuid4())
    if not re.fullmatch(r'[a-f0-9-]{36}', attempt_id):
        raise RestartBlocked('Invalid application attempt')
    record = {'attempt_id': attempt_id, 'status': 'starting', 'port': port, 'path': route,
              'members': {}, 'output': '', 'health': None}
    output_lock = threading.Lock()

    def emit(**event):
        # The log reader and health-check thread share stdout. Unbuffered print
        # writes the JSON and newline separately; without a lock they can merge
        # two events into an invalid line and permanently lose "ready".
        with output_lock:
            print(json.dumps(event), flush=True)

    with app_lock():
        if (STATE / f'app-{attempt_id}.cancel').exists():
            raise RestartBlocked('This application attempt was cancelled before it started')
        previous = read_json(STATE / 'app.json', None)
        if previous and app_owned(previous):
            raise RestartBlocked('A managed application is still running. Inspect app_status and stop it before replacement.')
        if app_listeners(process_snapshot(), {}, port):
            raise RestartBlocked(f'Port {port} is already occupied by an unowned or unknown process. No process was killed or started.')
        # Do not consume a newer attempt's environment if this SDK request was
        # delayed and already cancelled. Establish durable ownership before fork.
        payload = read_json(STATE / 'environment.json', {'values': {}, 'removed': []})
        (STATE / 'environment.json').unlink(missing_ok=True)
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('ANTHROPIC_', 'CLAUDE_', 'HC_')) and key != 'E2B_API_KEY'}
        for key in payload.get('removed', []):
            environment.pop(key, None)
        environment.update(payload.get('values', {}))
        environment['ENGELBART_CANVAS_APP_ATTEMPT'] = attempt_id
        write_private(STATE / 'app.json', record)
        # A new session plus an inherited tag keeps ownership distinct from the
        # supervisor. The tag and saved start times also identify orphaned children.
        proc = subprocess.Popen(['bash', '-c', command], cwd=cwd, env=environment, start_new_session=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        root = process_snapshot().get(proc.pid)
        if root:
            record['members'][str(proc.pid)] = root[1]
        write_private(STATE / 'app.json', record)

    def logs():
        while True:
            chunk = proc.stdout.readline(8192)
            if not chunk:
                break
            text = chunk.decode(errors='replace')
            with output_lock:
                record['output'] = (record['output'] + text)[-4000:]
            emit(phase='log', stream='stdout', text=text)

    thread = threading.Thread(target=logs, daemon=True)
    thread.start()
    deadline = time.monotonic() + 75
    ready = False
    previous_signature = None
    failure = None
    try:
        while True:
            if (STATE / f'app-{attempt_id}.cancel').exists():
                return
            owned = app_owned(record)
            record['members'].update({str(pid): row[1] for pid, row in owned.items()})
            snapshot = app_status(record)
            record['health'] = snapshot['health']
            code = proc.poll()
            record['status'] = 'exited' if code is not None else 'healthy' if snapshot['health'] and snapshot['health']['ok'] else 'unhealthy' if ready else 'starting'
            snapshot['status'] = record['status']
            with app_lock():
                current = read_json(STATE / 'app.json', None)
                if not current or current['attempt_id'] != attempt_id or (STATE / f'app-{attempt_id}.cancel').exists():
                    return
                write_private(STATE / 'app.json', record)
            signature = json.dumps({key: snapshot[key] for key in ('status', 'processes', 'listeners', 'health')}, sort_keys=True)
            if signature != previous_signature:
                emit(phase='app_status', status=record['status'], message=f"Application {record['status']} · {len(owned)} owned processes", app=snapshot)
                previous_signature = signature
            if code is not None:
                if code or not ready:
                    raise RestartBlocked(f'Application command exited with code {code} before a working preview was established' if not ready else f'Application command exited with code {code}')
                return
            if snapshot['health'] and snapshot['health']['ok'] and not ready:
                ready = True
                emit(phase='ready', port=port, url=snapshot['health']['url'], host=snapshot['health']['host'])
            if not ready and time.monotonic() >= deadline:
                raise RestartBlocked(f'Local HTTP readiness check failed on port {port}. See app_status for listeners and the last HTTP result.')
            time.sleep(1)
    except Exception as error:
        failure = str(error) if isinstance(error, RestartBlocked) else 'Application supervision failed'
        raise
    finally:
        # Never report a failed attempt with untracked children still running.
        # Failure to confirm cleanup is an explicit error and blocks replacement.
        stop_owned_app(attempt_id)
        thread.join(timeout=1)
        with app_lock():
            current = read_json(STATE / 'app.json', None)
            if current and current['attempt_id'] == attempt_id:
                current.update(status='failed' if failure else 'stopped', error=failure, output=record['output'], health=record['health'])
                write_private(STATE / 'app.json', current)


def main():
    global STEP
    os.environ.setdefault('HUMAN_COMPACT_HOME', '/home/user/.human-compact')
    if '--app-status' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else None
        if port is not None and not 1024 <= port <= 65535:
            raise RestartBlocked('Invalid application port')
        print(json.dumps(app_status(port=port)), flush=True)
        return
    if '--stop-app' in sys.argv:
        stop_owned_app(sys.argv[sys.argv.index('--stop-app') + 1])
        print(json.dumps(app_status(probe=False)), flush=True)
        return
    if '--stop' in sys.argv:
        STEP = 'stopping the previous application'
        stop_launch(local_tools='--reset-local' in sys.argv)
        if '--reset-local' in sys.argv:
            # Only after a confirmed stop: a leftover local recipe would cause
            # the API fallback to relaunch that app instead of running setup.
            (STATE / 'recipe.json').unlink(missing_ok=True)
        return
    recipe = read_json(STATE / 'recipe.json', None)
    if recipe and recipe.get('kind') == 'claude-local':
        STEP = 'starting the saved local Claude launch plan'
        local_recipe(recipe)
        if '--check' not in sys.argv:
            if '--attempt' in sys.argv:
                launch_local(recipe, sys.argv[sys.argv.index('--attempt') + 1])
            else:
                launch_local(recipe)
        return
    wrapper = load_wrapper()
    from human_compact.trajectory import project_environment as PE, project_run as PR, project_supabase as PS
    port = int(os.environ.get('ENGELBART_CANVAS_PORT', '0'))
    if '--check' in sys.argv:
        write_private(STATE / 'recipe.json', recipe_for(wrapper, PR, port))
        return
    payload_file = STATE / 'environment.json'
    STEP = 'loading saved environment settings'
    payload = read_json(payload_file, {'values': {}, 'removed': []})
    if payload_file.exists():
        payload_file.unlink()
    values, removed = payload['values'], set(payload['removed'])
    install_environment(wrapper, PE, PR, values, removed)
    original_emit = wrapper.emit

    def emit(**event):
        if event.get('phase') == 'recipe' and event.get('status') == 'captured' and event.get('recipe'):
            write_private(STATE / 'recipe.json', event['recipe'])
            event = {'phase': 'recipe', 'status': 'captured', 'message': 'Launch plan saved in sandbox'}
        original_emit(**event)
    wrapper.emit = emit
    if '--restart' not in sys.argv:
        STEP = 'setting up the repository'
        sys.argv = [WRAPPER, str(ROOT)]
        wrapper.main()
        return
    STEP = 'reading the saved launch plan'
    recipe = recipe_for(wrapper, PR, port)
    wrapper.REPO = str(ROOT)
    # A settings restart must not turn into another paid setup/repair attempt
    # or provision a new database when a variable is removed.
    from human_compact.trajectory import project_setup as setup
    setup.MAX_ATTEMPTS = 0
    wrapper.local_supabase = lambda *args: (set(), None)
    emit(phase='setup', status='reusing', message='Reusing installed files; restarting application')
    STEP = 'starting the saved application commands'
    if recipe.get('kind') == 'setup':
        if not wrapper.start_app(str(ROOT), recipe['startUrl']):
            raise ValueError('Application could not restart with this environment')
        wrapper.go_live(wrapper.APP['url'])
        wrapper.stay_alive()
        return
    recipe = json.loads(json.dumps(recipe))
    recipe.pop('patch', None)  # already applied in this working tree
    recipe.pop('hint', None)
    if recipe.get('orderPlan'):
        recipe['orderPlan']['preparation'] = []
    if recipe.get('plan'):
        recipe['plan']['steps'] = []
    run_id, cwd = wrapper.replay(PR, str(ROOT), recipe)
    if wrapper.run(PR, PE, PS, run_id, cwd, str(ROOT)) != 'ready':
        raise ValueError('Application could not restart with this environment; the sandbox and files were kept')
    wrapper.supervise(PR, run_id)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Exceptions from third-party setup code may contain values. Do not
        # print their payload/traceback; worker reports a bounded failure.
        message = str(exc) if isinstance(exc, RestartBlocked) else f'Application launch failed while {STEP}. See the preceding build steps for details.'
        print(json.dumps({'phase': 'error', 'message': message}), flush=True)
        sys.exit(1)

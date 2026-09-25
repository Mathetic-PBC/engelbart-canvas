"""Canvas adapter installed into an existing E2B sandbox, not its template.

Reuses hc's saved launch plan, but never replays installation on an env restart.
The repository is disposable code; the payload and recipe stay outside it.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

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


def launcher_roots(processes, local_tools=False):
    roots = {pid for pid, (_, _, command) in processes.items() if
             WRAPPER in command or '/opt/engelbart/proxy.mjs' in command or
             (str(STATE / 'launch.py') in command and '--stop' not in command and '--check' not in command)}
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


def launch_local(recipe):
    # No hc imports or model calls: this is also the subscription-mode restart.
    cwd, command, port, route = local_recipe(recipe)
    payload = read_json(STATE / 'environment.json', {'values': {}, 'removed': []})
    (STATE / 'environment.json').unlink(missing_ok=True)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('ANTHROPIC_', 'CLAUDE_', 'HC_')) and key != 'E2B_API_KEY'}
    for key in payload.get('removed', []):
        environment.pop(key, None)
    environment.update(payload.get('values', {}))

    output_lock = threading.Lock()

    def emit(**event):
        # The log reader and health-check thread share stdout. Unbuffered print
        # writes the JSON and newline separately; without a lock they can merge
        # two events into an invalid line and permanently lose "ready".
        with output_lock:
            print(json.dumps(event), flush=True)

    proc = subprocess.Popen(['bash', '-c', command], cwd=cwd, env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)

    def logs():
        while True:
            chunk = proc.stdout.readline(8192)
            if not chunk:
                break
            emit(phase='log', stream='stdout', text=chunk.decode(errors='replace'))

    thread = threading.Thread(target=logs, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{port}{route}'
    # Ignore proxy environment configuration when probing this machine's app.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            thread.join(timeout=1)
            raise ValueError('Application exited before becoming healthy')
        try:
            with client.open(url, timeout=2) as response:
                healthy = response.status < 500
        except urllib.error.HTTPError as error:
            healthy = error.code < 500
        except (OSError, urllib.error.URLError):
            healthy = False
        if healthy:
            emit(phase='ready', port=port, url=url)
            code = proc.wait()
            thread.join(timeout=1)
            if code:
                raise ValueError('Application stopped with an error')
            return
        time.sleep(0.5)
    raise ValueError('Application did not become healthy')


def main():
    global STEP
    os.environ.setdefault('HUMAN_COMPACT_HOME', '/home/user/.human-compact')
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

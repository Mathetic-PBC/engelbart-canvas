"""Linux supervisor behavior tested with explicit process/socket fixtures on any host."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('launch', Path(__file__).parent.parent / 'src/main/sandbox/launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)
attempt = '12345678-1234-1234-1234-123456789abc'

with tempfile.TemporaryDirectory() as temp:
    launch.STATE = Path(temp) / 'state'
    launch.ROOT = Path(temp) / 'repo'
    launch.ROOT.mkdir()
    record = {'attempt_id': attempt, 'status': 'unhealthy', 'port': 5173, 'members': {'501': 'old', '599': 'stale'}, 'output': 'meaningful error'}
    # Supervisor is gone. One remembered child and another tagged child were
    # reparented to init; 599 is a reused PID belonging to someone else.
    processes = {501: (1, 'old', 'node server'), 502: (1, 'child', 'node vite'),
                 503: (502, 'grandchild', 'esbuild'), 599: (1, 'new', 'unrelated')}
    def environ(file):
        return f'ENGELBART_CANVAS_APP_ATTEMPT={attempt}\0'.encode() if str(file) == '/proc/502/environ' else b'PATH=/bin\0'
    with patch.object(launch, 'process_snapshot', side_effect=lambda: dict(processes)), patch.object(launch.Path, 'read_bytes', new=environ):
        assert set(launch.app_owned(record)) == {501, 502, 503}
        launch.write_private(launch.STATE / 'app.json', record)
        killed = []
        def kill(pid, sig):
            assert pid != 599, 'PID reuse must never kill a foreign process'
            assert str(pid) in json.loads((launch.STATE / 'app.json').read_text())['members']
            killed.append(pid)
            processes.pop(pid, None)
        with patch.object(launch.os, 'kill', side_effect=kill), patch.object(launch.time, 'sleep'):
            launch.stop_owned_app(attempt)
        assert set(killed) == {501, 502, 503}
        assert list(processes) == [599]
        assert (launch.STATE / f'app-{attempt}.cancel').exists()
        assert json.loads((launch.STATE / 'app.json').read_text())['status'] == 'stopped'
        launch.stop_owned_app(attempt)  # Repeat safely after cleanup.
    print('Orphaned children are owned across supervisor exits; PID reuse and unrelated services are preserved.')

    recipe = {'command': 'npm run dev', 'cwd': str(launch.ROOT), 'port': 5173}
    launch.write_private(launch.STATE / 'environment.json', {'values': {'NEW': 'new-attempt-value'}})
    with patch.object(launch.subprocess, 'Popen') as start:
        try:
            launch.launch_local(recipe, attempt)
            raise AssertionError('A delayed cancelled attempt was started')
        except launch.RestartBlocked as error:
            assert 'cancelled' in str(error)
        start.assert_not_called()
        assert (launch.STATE / 'environment.json').exists(), 'A delayed cancelled attempt must not consume the next launch environment'
    print('Cancellation fences delayed SDK launches before they can create processes.')

    launch.write_private(launch.STATE / 'app.json', {**record, 'members': {'501': 'old'}})
    with patch.object(launch, 'process_snapshot', return_value={501: (1, 'old', 'node')}), \
         patch.object(launch.Path, 'read_bytes', return_value=b''), patch.object(launch.os, 'kill'), patch.object(launch.time, 'sleep'):
        try:
            launch.stop_owned_app(attempt)
            raise AssertionError('Unconfirmed cleanup must block replacement')
        except launch.RestartBlocked:
            pass
    print('Unconfirmed process termination stays blocked, not falsely stopped.')

    # A foreign listener is never killed to clear the chosen preview port.
    launch.write_private(launch.STATE / 'app.json', {**record, 'members': {}})
    with patch.object(launch, 'process_snapshot', return_value={599: (1, 'new', 'foreign')}), \
         patch.object(launch.Path, 'read_bytes', return_value=b''), \
         patch.object(launch, 'app_listeners', return_value=[{'port': 5173, 'address': '::1', 'pids': [599], 'ownership': 'unowned'}]), \
         patch.object(launch.subprocess, 'Popen') as start, patch.object(launch.os, 'kill') as kill:
        try:
            launch.launch_local(recipe)
            raise AssertionError('An occupied port must block launch')
        except launch.RestartBlocked as error:
            assert '5173' in str(error) and 'unowned' in str(error)
        start.assert_not_called()
        kill.assert_not_called()
    print('Foreign port conflicts are reported without killing or starting any process.')

class Response:
    def __init__(self, code): self.status = code
    def __enter__(self): return self
    def __exit__(self, *args): pass

urls = []
def check(url, **kwargs):
    urls.append(url)
    return Response(200)
with patch.object(launch.urllib.request, 'build_opener', return_value=SimpleNamespace(open=check)):
    result = launch.app_health([{'port': 5173, 'address': '::1', 'ownership': 'owned'}], 5173, '/')
    assert result['ok'] and result['host'] == '::1'
    assert urls == ['http://[::1]:5173/']
    result = launch.app_health([{'port': 5173, 'address': '127.0.0.1', 'ownership': 'unowned'}], 5173, '/')
    assert not result['ok'] and len(urls) == 1, 'An unrelated service must not establish readiness'
with patch.object(launch.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *args, **kwargs: Response(404))):
    result = launch.app_health([{'port': 5173, 'address': '127.0.0.1', 'ownership': 'owned'}], 5173, '/')
    assert not result['ok'] and result['checks'][0]['http_status'] == 404
with patch.object(launch.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *args, **kwargs: (_ for _ in ()).throw(OSError('private error detail')))):
    result = launch.app_health([{'port': 5173, 'address': '127.0.0.1', 'ownership': 'owned'}], 5173, '/')
    assert not result['ok'] and 'private error detail' not in json.dumps(result)
print('IPv6 localhost is checked at its actual address; foreign listeners, HTTP errors, and connection errors are not healthy.')

# Decode real /proc-style IPv4 and IPv6 entries and correlate socket owners.
read_text = launch.Path.read_text
iterdir = launch.Path.iterdir
def contents(file, *args, **kwargs):
    if str(file) == '/proc/net/tcp':
        return 'header\n 0: 0100007F:0BB9 00000000:0000 0A 0:0 0:0 0 1000 0 901\n'
    if str(file) == '/proc/net/tcp6':
        return 'header\n 0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 902\n'
    return read_text(file, *args, **kwargs)
def fds(file):
    if str(file).startswith('/proc/'):
        return iter([file / '3'])
    return iterdir(file)
with patch.object(launch.Path, 'read_text', new=contents), patch.object(launch.Path, 'iterdir', new=fds), \
     patch.object(launch.os, 'readlink', side_effect=lambda file: 'socket:[901]' if '/501/' in str(file) else 'socket:[902]'):
    rows = launch.app_listeners({501: (), 502: ()}, {501: ()}, 5173)
    assert rows == [{'address': '127.0.0.1', 'port': 3001, 'pids': [501], 'ownership': 'owned'},
                    {'address': '::1', 'port': 5173, 'pids': [502], 'ownership': 'unowned'}]
print('Listener snapshots expose addresses and both backend/frontend ports without logging process arguments or environment values.')

with tempfile.TemporaryDirectory() as temp:
    launch.STATE = Path(temp) / 'state'
    launch.ROOT = Path(temp) / 'repo'
    launch.ROOT.mkdir()
    launch.write_private(launch.STATE / 'environment.json', {
        'values': {'API_KEY': 'private-fixture-value', 'EMPTY': ''}, 'removed': ['OLD_KEY']})
    output = io.StringIO()
    recipe = {'command': 'npm start', 'cwd': str(launch.ROOT), 'port': 3000}
    def capture_start(*args, **kwargs):
        assert kwargs['env']['API_KEY'] == 'private-fixture-value'
        assert kwargs['env']['EMPTY'] == ''
        assert 'OLD_KEY' not in kwargs['env']
        raise RuntimeError('fixture: stop before creating an actual process')
    with patch.object(launch, 'process_snapshot', return_value={}), \
         patch.object(launch, 'app_listeners', return_value=[]), \
         contextlib.redirect_stdout(output), \
         patch.object(launch.subprocess, 'Popen', side_effect=capture_start), \
         patch.dict(os.environ, {'OLD_KEY': 'old-private-value'}):
        try:
            launch.launch_local(recipe)
        except RuntimeError as error:
            assert str(error).startswith('fixture:')
        else:
            raise AssertionError('Fixture must intercept process creation')
    emitted = [json.loads(line) for line in output.getvalue().splitlines()]
    applied = next(event for event in emitted if event['phase'] == 'environment')
    assert applied['provided_names'] == ['API_KEY', 'EMPTY']
    assert applied['removed_names'] == ['OLD_KEY']
    assert applied['requirements_scan'] == 'not_run'
    assert 'variables' not in applied, 'Applying values must not masquerade as a requirement scan'
    assert 'private-fixture-value' not in json.dumps(emitted)
    assert 'old-private-value' not in json.dumps(emitted)
print('Environment application records names only, explicitly distinguishes injection from scanning, and preserves existing values/removal behavior.')

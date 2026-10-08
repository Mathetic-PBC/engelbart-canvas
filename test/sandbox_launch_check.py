import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('launch', Path(__file__).parent.parent / 'src/main/sandbox/launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)

with tempfile.TemporaryDirectory() as temp:
    base = Path(temp)
    launch.ROOT = base / 'repository'
    launch.STATE = base / 'state'
    launch.ROOT.mkdir()
    store = base / 'environments'
    store.mkdir()
    launch.write_private(store / 'root.json', {'OLD': 'old-secret', 'EDIT': 'old-edit', 'DATABASE_URL': 'generated'})
    launch.write_private(store / 'child.json', {'OLD': 'old-secret', 'SERVICE_URL': 'auto'})
    launch.write_private(launch.STATE / 'managed.json', ['OLD', 'EDIT'])
    observed = []
    def script():
        observed.append(dict(os.environ))
    wrapper = SimpleNamespace(run_script=script, start_app=script)
    PE = SimpleNamespace(storage=lambda root: (store, 'root.json'), scan=lambda *args, **kwargs: {'variables': [{'name': 'OLD'}, {'name': 'EDIT'}]})
    def original_env(cwd, inherited, validate, skipped):
        return ({'OLD': 'dotenv-old', 'EDIT': 'dotenv-edit', 'PATH': '/bin'}, {'OLD': 'dotenv-old'}, lambda text: text)
    PR = SimpleNamespace(environment=original_env)
    values = {'EDIT': ' new$"value\n ', 'ARBITRARY_NOT_SCANNED': 'works', 'EMPTY': ''}
    launch.install_environment(wrapper, PE, PR, values, {'OLD'})
    assert json.loads((store / 'root.json').read_text()) == {'DATABASE_URL': 'generated'}
    assert json.loads((store / 'child.json').read_text()) == {'SERVICE_URL': 'auto'}
    environment, selected, redact = PR.environment(str(launch.ROOT))
    assert 'OLD' not in environment and 'OLD' not in selected
    assert environment['EDIT'] == values['EDIT']
    assert environment['ARBITRARY_NOT_SCANNED'] == 'works'
    assert environment['EMPTY'] == ''
    assert values['EDIT'] not in redact(values['EDIT'])
    assert PE.scan(str(launch.ROOT))['variables'][1]['status'] == 'found'
    before = dict(os.environ)
    os.environ['ANTHROPIC_API_KEY'] = 'platform-secret'
    os.environ['OLD'] = 'old-secret'
    wrapper.start_app()
    assert observed[0]['EDIT'] == values['EDIT']
    assert 'OLD' not in observed[0] and 'ANTHROPIC_API_KEY' not in observed[0]
    assert os.environ['ANTHROPIC_API_KEY'] == 'platform-secret'
    os.environ.clear()
    os.environ.update(before)
    assert (store / 'root.json').stat().st_mode & 0o777 == 0o600
print('Cached keys removed in all components; process overrides, empty/multiline values, redaction, and runner credential isolation verified.')

with tempfile.TemporaryDirectory() as temp:
    base = Path(temp)
    launch.ROOT = base / 'repository'
    launch.STATE = base / 'state'
    launch.ROOT.mkdir()
    runs = base / 'hc' / 'project-runs'
    run_file = runs / ('a' * 32 + '.json')
    unrelated_file = runs / ('b' * 32 + '.json')
    failed_file = runs / ('c' * 32 + '.json')
    record = {'cwd': str(launch.ROOT), 'repositoryRoot': str(launch.ROOT),
              'orderPlan': {'services': [{'id': 'web'}]},
              'run': {'status': 'running', 'healthy': True, 'pid': 402, 'url': 'http://localhost:3000', 'stages': [{'stdout': 'prior output'}]}}
    unrelated = {**record, 'cwd': str(base / 'other'), 'repositoryRoot': str(base / 'other')}
    failed = {**record, 'run': {'status': 'failed', 'reason': 'Prior failure'}}
    launch.write_private(run_file, record)
    launch.write_private(unrelated_file, unrelated)
    launch.write_private(failed_file, failed)
    processes = {401: (1, '101', f'python3 {launch.STATE}/launch.py'),
                 402: (401, '102', 'python3 app.py'),
                 499: (1, '199', 'dockerd')}
    def kill(pid, sig):
        assert json.loads(run_file.read_text())['run']['status'] == 'running', 'Do not clear ownership before stopping the app'
        assert pid != 499, 'Unrelated services must be preserved'
        processes.pop(pid, None)
    with patch.dict(os.environ, {'HUMAN_COMPACT_HOME': str(base / 'hc')}), \
         patch.object(launch, 'process_snapshot', side_effect=lambda: dict(processes)), \
         patch.object(launch.os, 'kill', side_effect=kill), patch.object(launch.time, 'sleep'):
        launch.stop_launch()
        stopped = json.loads(run_file.read_text())
        assert stopped['run']['status'] == 'stopped' and not stopped['run']['healthy']
        assert stopped['run']['pid'] is None and stopped['run']['url'] is None
        assert stopped['run']['stages'] == record['run']['stages']
        assert stopped['orderPlan'] == record['orderPlan'], 'Keep the launch plan and history'
        assert json.loads(unrelated_file.read_text()) == unrelated
        assert json.loads(failed_file.read_text()) == failed
        launch.stop_launch()  # Repeated cleanup is safe, including after a failed handoff.
        assert list(processes) == [499]

        launch.write_private(run_file, record)
        processes[401] = (1, '101', f'python3 {launch.STATE}/launch.py')
        with patch.object(launch.os, 'kill'):
            try:
                launch.stop_launch()
            except RuntimeError:
                pass
            else:
                raise AssertionError('An unconfirmed stop must block the replacement launch')
        assert json.loads(run_file.read_text()) == record
        processes.pop(401)
        processes[402] = (1, '102', 'python3 app.py')  # An orphan outside the wrapper tree.
        readlink = os.readlink
        with patch.object(launch.os, 'readlink', side_effect=lambda path, *args, **kwargs:
                          str(launch.ROOT) if str(path) == '/proc/402/cwd' else readlink(path, *args, **kwargs)):
            try:
                launch.stop_launch()
            except RuntimeError:
                pass
            else:
                raise AssertionError('A live application PID must keep its ownership record')
        assert json.loads(run_file.read_text()) == record
print('Native restart retires prior ownership only after confirmed stop; history, other projects, and services are preserved.')

with tempfile.TemporaryDirectory() as temp:
    base = Path(temp)
    launch.ROOT = base / 'repository'
    launch.STATE = base / 'state'
    launch.ROOT.mkdir()
    recipe = {'kind': 'claude-local', 'command': 'npm start', 'cwd': str(launch.ROOT), 'port': 3000, 'path': '/'}
    launch.write_private(launch.STATE / 'recipe.json', recipe)
    for bad in ({'cwd': str(base)}, {'port': True}, {'port': 43110}, {'path': '//external.example'}, {'command': ''}):
        try:
            launch.local_recipe({**recipe, **bad})
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe local launch recipe accepted')
    with patch.object(launch, 'load_wrapper', side_effect=AssertionError('must not import hc or use API')), \
         patch.object(launch, 'launch_local') as start:
        with patch.object(sys, 'argv', ['launch.py', '--check']):
            launch.main()
            start.assert_not_called()
        with patch.object(sys, 'argv', ['launch.py', '--restart']):
            launch.main()
            start.assert_called_once_with(recipe)
print('Local Claude restart validates the saved plan and bypasses hc/model calls entirely.')

with tempfile.TemporaryDirectory() as temp:
    launch.STATE = Path(temp)
    wrapper = SimpleNamespace(emit=lambda **event: None, main=lambda: (_ for _ in ()).throw(AssertionError('setup is never hc\'s')))
    with patch.object(sys, 'argv', ['launch.py']), \
         patch.object(launch, 'load_wrapper', return_value=wrapper), \
         patch.object(launch, 'install_environment'), \
         patch.dict(sys.modules, {'human_compact': SimpleNamespace(), 'human_compact.trajectory': SimpleNamespace(project_environment=None, project_run=None, project_supabase=None)}):
        try:
            launch.main()
        except launch.RestartBlocked as error:
            assert 'no saved launch plan' in str(error)
        else:
            raise AssertionError('Without a saved plan launch.py must refuse rather than set up with hc')
print('Without a saved plan launch.py refuses: setup is Claude Code\'s, never hc\'s.')

processes = {501: (1, '101', 'npm install'), 502: (501, '102', 'installer-child'), 599: (1, '199', 'unrelated-service')}
def kill_any(pid, sig):
    raise AssertionError('Stopping the app must not touch processes outside its launcher tree')
with patch.object(launch, 'process_snapshot', side_effect=lambda: dict(processes)), \
     patch.object(launch.os, 'kill', side_effect=kill_any), \
     patch.object(launch, 'retire_launch_records'), \
     patch.object(launch, 'stop_owned_app'):
    launch.stop_launch()
    assert len(processes) == 3, 'Setup tools and services outside the launcher are left alone'
print('Stopping the launcher leaves setup tools and unrelated services alone.')

with tempfile.TemporaryDirectory() as temp:
    launch.ROOT = Path(temp) / 'repository'
    launch.STATE = Path(temp) / 'state'
    launch.ROOT.mkdir()
    recipe = {'kind': 'claude-local', 'command': 'app', 'cwd': str(launch.ROOT), 'port': 3000, 'path': '/'}
    launch.write_private(launch.STATE / 'environment.json', {'values': {'APP_SECRET': 'fixture'}, 'removed': ['REMOVED']})

    class SlowOutput(io.StringIO):
        def write(self, value):
            result = super().write(value)
            time.sleep(0.001)  # Mimic the GIL release between unbuffered writes.
            return result

    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass

    outcomes = iter([None, 0])
    process = SimpleNamespace(pid=701, stdout=io.BytesIO(b'concurrent app log\n' * 100), poll=lambda: next(outcomes), wait=lambda: 0)
    captured = SlowOutput()
    with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'runner-key', 'CLAUDE_CODE_OAUTH_TOKEN': 'runner-token', 'REMOVED': 'old'}), \
         patch.object(launch.subprocess, 'Popen', return_value=process) as popen, \
         patch.object(launch, 'process_snapshot', return_value={701: (1, '100', 'npm start')}), \
         patch.object(launch, 'app_listeners', side_effect=lambda processes, owned, port: [{'ownership': 'owned', 'port': port, 'address': '127.0.0.1', 'pids': [701]}] if owned else []), \
         patch.object(launch, 'stop_owned_app') as stop, \
         patch.object(launch.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *args, **kwargs: Response())), \
         contextlib.redirect_stdout(captured):
        launch.launch_local(recipe)
    events = [json.loads(line) for line in captured.getvalue().splitlines()]
    assert sum(event['phase'] == 'ready' for event in events) == 1
    assert sum(event['phase'] == 'log' for event in events) == 100
    assert popen.call_args.kwargs['env']['APP_SECRET'] == 'fixture'
    assert popen.call_args.kwargs['start_new_session'] is True
    assert popen.call_args.kwargs['env']['ENGELBART_CANVAS_APP_ATTEMPT']
    stop.assert_called_once_with(popen.call_args.kwargs['env']['ENGELBART_CANVAS_APP_ATTEMPT'])
    assert all(key not in popen.call_args.kwargs['env'] for key in ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'REMOVED'])
    assert not (launch.STATE / 'environment.json').exists()
print('Concurrent application logs and readiness retain separate JSON lines; only app environment reaches the process.')

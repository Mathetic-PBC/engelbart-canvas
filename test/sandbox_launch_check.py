import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
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

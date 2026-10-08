import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

source = Path(__file__).parent.parent / 'src/main/sandbox/npm-audit.py'
spec = importlib.util.spec_from_file_location('npm_audit', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
counts = {'info': 0, 'low': 1, 'moderate': 0, 'high': 2, 'critical': 0, 'total': 3}
report = {'metadata': {'vulnerabilities': counts}, 'vulnerabilities': {'sample': {'severity': 'high'}}}
assert helper.summarize(report, 1)['status'] == 'findings'
assert 'sample (high)' in helper.summarize(report, 1)['message']
clean = {'metadata': {'vulnerabilities': dict.fromkeys(counts, 0)}}
assert helper.summarize(clean, 0)['status'] == 'complete'
for bad, code in [({}, 0), (clean, 1), (report, 2), ({**report, 'error': {'code': 'E401'}}, 1),
                  ({'metadata': {'vulnerabilities': {'total': 0}}}, 0)]:
    try:
        helper.summarize(bad, code)
        raise AssertionError('Incomplete audit looked successful')
    except ValueError:
        pass

with tempfile.TemporaryDirectory() as temporary:
    helper.ROOT = Path(temporary)

    def project(relative, package=None):
        root = helper.ROOT / relative
        root.mkdir(parents=True, exist_ok=True)
        (root / 'package.json').write_text(json.dumps(package or {'name': 'fixture'}))
        (root / 'package-lock.json').write_text('{}')
        (root / 'node_modules').mkdir(exist_ok=True)
        return root

    npm = project('system/frontend')
    project('system/frontend/node_modules/ignored')
    workspace = project('workspace', {'workspaces': ['client']})
    project('workspace/client')
    other = project('pnpm-project')
    (other / 'pnpm-lock.yaml').touch()
    not_installed = helper.ROOT / 'not-installed'
    not_installed.mkdir()
    (not_installed / 'package.json').write_text('{}')
    (not_installed / 'package-lock.json').write_text('{}')
    assert helper.projects() == ([npm, workspace], False)

    def popen(command, **options):
        assert command == ['npm', 'audit', '--json', '--audit=true']
        assert options['cwd'] == npm
        assert options['env']['npm_config_audit'] == 'true'
        assert options['env']['npm_config_fetch_retries'] == '0'
        options['stdout'].write(json.dumps(report).encode())
        return SimpleNamespace(wait=lambda timeout: 1, poll=lambda: 1)

    with patch.object(helper.subprocess, 'Popen', side_effect=popen):
        assert helper.audit(npm, 2)['status'] == 'findings'

    killed = []
    def timeout_popen(*args, **kwargs):
        def wait(timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired('npm audit', timeout)
        return SimpleNamespace(pid=999999, wait=wait, poll=lambda: None)
    with patch.object(helper.subprocess, 'Popen', side_effect=timeout_popen), \
         patch.object(helper.os, 'killpg', side_effect=lambda *args: killed.append(args)):
        try:
            helper.audit(npm, 1)
            raise AssertionError('Timeout swallowed')
        except subprocess.TimeoutExpired:
            pass
    assert killed == [(999999, helper.signal.SIGKILL)]

    emitted = []
    with patch.object(helper, 'emit', side_effect=lambda status, message, **details: emitted.append((status, message))), \
         patch.object(helper, 'audit', side_effect=ValueError('Registry private-token')):
        helper.main()
    assert any(status == 'unavailable' for status, _ in emitted)
    assert not any('private-token' in message for _, message in emitted)

print('Deferred audit checks passed')

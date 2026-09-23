import importlib.util
import json
from pathlib import Path
import signal
import sys
import tempfile
from unittest.mock import patch
from types import SimpleNamespace

sys.dont_write_bytecode = True
source = Path(__file__).parent.parent / 'src/main/sandbox'
sys.path.insert(0, str(source))
spec = importlib.util.spec_from_file_location('install_job', source / 'install-job.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

with tempfile.TemporaryDirectory() as temporary:
    base = Path(temporary)
    helper.ROOT = base / 'repo'
    helper.STATE = base / 'state'
    helper.ROOT.mkdir()
    helper.STATE.mkdir()
    job_id = '00000000-0000-0000-0000-000000000001'
    (helper.ROOT / 'package.json').write_text(json.dumps({'name': 'app', 'scripts': {'dev': 'vite'}}))
    (helper.ROOT / 'package-lock.json').write_text('{}')
    (helper.ROOT / '.nvmrc').write_text('22')
    (helper.ROOT / 'node_modules').mkdir()
    (helper.ROOT / 'node_modules/package.json').write_text('{}')
    with patch.object(helper, 'version', return_value='22.15.0'):
        facts = helper.inspect()
    assert facts['package']['name'] == 'app'
    assert facts['lockfiles'] == ['package-lock.json']
    assert facts['runtimeFiles'] == {'.nvmrc': '22'}
    assert facts['nestedManifests'] == []
    assert not any(row['name'] == 'node_modules' for row in facts['files']['entries'])
    (helper.ROOT / 'client').mkdir()
    (helper.ROOT / 'client/package.json').write_text('{}')
    with patch.object(helper, 'version', return_value='22.15.0'):
        assert helper.inspect()['nestedManifests'] == ['client/package.json']
    try:
        helper.listing('../state')
        raise AssertionError('escaped repository')
    except ValueError:
        pass
    (helper.ROOT / 'escape').symlink_to(helper.STATE, target_is_directory=True)
    try:
        helper.listing('escape')
        raise AssertionError('escaped through symlink')
    except ValueError:
        pass
    for i in range(210):
        (helper.ROOT / f'file-{i}').touch()
    listing = helper.listing('.')
    assert listing['truncated'] and len(listing['entries']) == 200

    # Exact job tags select only that job, plus children that dropped the tag.
    snapshot = {301: (1, 'a', 'install'), 302: (301, 'b', 'child'),
                303: (1, 'c', 'other job'), 304: (302, 'd', 'grandchild')}
    marker = f'ENGELBART_CANVAS_INSTALL_JOB={job_id}'.encode()
    environments = {301: b'PATH=/bin\0' + marker + b'\0', 302: b'PATH=/bin\0',
                    303: marker + b'-different\0', 304: b'PATH=/bin\0'}
    def proc_path(value):
        pid = int(str(value).split('/')[2])
        return SimpleNamespace(read_bytes=lambda: environments[pid])
    with patch.object(helper, 'process_snapshot', return_value=snapshot), patch.object(helper, 'Path', side_effect=proc_path):
        assert set(helper.marked(job_id)) == {301, 302, 304}

    # A child which ignores TERM remains tracked after losing its parent/tag.
    processes = {101: (1, 'parent-start', 'install'), 102: (101, 'child-start', 'child')}
    calls = []
    first = True
    def marked(_job):
        global first
        if first:
            first = False
            return dict(processes)
        return {}
    def kill(pid, sig):
        calls.append((pid, sig))
        if pid == 101 or sig == signal.SIGKILL:
            processes.pop(pid, None)
    with patch.object(helper, 'marked', side_effect=marked), patch.object(helper, 'process_snapshot', side_effect=lambda: dict(processes)), \
         patch.object(helper.os, 'kill', side_effect=kill), patch.object(helper.time, 'sleep'):
        helper.stop(job_id)
    assert not processes
    assert (102, signal.SIGKILL) in calls
    assert (helper.STATE / f'install-{job_id}.cancel').exists()

    # The tombstone prevents a late SDK request from resurrecting a stopped job.
    with patch.object(helper.subprocess, 'call', side_effect=AssertionError('must not launch')):
        assert helper.run(job_id) == 130

    # A PID reused by another process must never be killed.
    old = {201: (1, 'old', 'install')}
    newer = {201: (1, 'new', 'unrelated')}
    with patch.object(helper, 'marked', side_effect=[old, {}, {}]), patch.object(helper, 'process_snapshot', return_value=newer), \
         patch.object(helper.os, 'kill', side_effect=AssertionError('PID reused')):
        helper.stop(job_id)

    # Persistent live processes prevent success/replacement.
    with patch.object(helper, 'marked', return_value=old), patch.object(helper, 'process_snapshot', return_value=old), \
         patch.object(helper.os, 'kill'), patch.object(helper.time, 'sleep'):
        try:
            helper.stop(job_id)
            raise AssertionError('unconfirmed stop accepted')
        except RuntimeError as error:
            assert 'no replacement' in str(error)

print('Dependency install helper checks passed')

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

sys.modules['launch'] = types.SimpleNamespace(ROOT=None, STATE=None)
spec = importlib.util.spec_from_file_location('discovery', Path(__file__).parents[1] / 'src/main/sandbox/launch-discovery.py')
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class DiscoveryTests(unittest.TestCase):
    def test_allowlist(self):
        info = {'success': True, 'detectedProviders': ['node'], 'resolvedPackages': {'node': {'requestedVersion': 'lts', 'resolvedVersion': '99', 'source': 'railpack default'}},
                'logs': [{'Level': 'error', 'Msg': 'meaningful failure'}], 'metadata': {'nodeRuntime': 'next', 'SECRET': 'hidden'}}
        plan = {'deploy': {'startCommand': 'npm start', 'variables': {'SECRET': 'hidden'}},
                'steps': [{'name': 'build', 'commands': [{'cmd': 'npm run build'}, {'path': '/layers'}], 'assets': {'SECRET': 'hidden'}}], 'caches': {'SECRET': 'hidden'}}
        compact = discovery.compact_railpack(info, plan)
        self.assertNotIn('hidden', json.dumps(compact))
        self.assertNotIn('resolvedVersion', json.dumps(compact))
        self.assertEqual(compact['commands']['build'], ['npm run build'])
        self.assertEqual(compact['warnings'], ['meaningful failure'])

    def test_components_and_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            discovery.ROOT = Path(directory)
            discovery.STATE = Path(directory)
            def package(cwd, content):
                root = Path(directory) / cwd
                root.mkdir(parents=True, exist_ok=True)
                (root / 'package.json').write_text(json.dumps(content))
            package('.', {'workspaces': ['client', 'server'], 'scripts': {'dev': 'concurrently ...'}})
            package('client', {'scripts': {'dev': 'vite'}})
            package('server', {'scripts': {'dev': 'tsx watch src/index.ts'}})
            package('node_modules/ignored', {})
            package('separate', {'scripts': {'start': 'node app.js'}})
            (Path(directory) / 'linked').symlink_to('/tmp', target_is_directory=True)
            discovery.analyze = lambda component: {'status': 'planned'}
            data = discovery.discover()
            self.assertEqual([c['cwd'] for c in data['components']], ['.', 'client', 'separate', 'server'])
            self.assertEqual(data['components'][1]['workspace_root'], '.')
            self.assertNotIn('workspace_root', data['components'][2])
            self.assertIn('railpack', data['components'][2])
            discovery.analyze = lambda _: {'status': 'planned', 'oversized': 'a' * 15000}
            data = discovery.discover()
            self.assertLessEqual(len(json.dumps(data).encode()), 12000)
            self.assertTrue(data['scan_truncated'])


if __name__ == '__main__':
    unittest.main()

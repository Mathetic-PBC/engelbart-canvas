"""Bounded, read-only launch facts and Railpack hints. Never builds/installs/runs a repo."""
from concurrent.futures import ThreadPoolExecutor
import fnmatch
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

from launch import ROOT, STATE

IGNORE = {'.git', 'node_modules', '.venv', 'venv', 'vendor', '.next', 'dist', 'build', '__pycache__'}
MANIFESTS = {'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json'}
LOCKS = {'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock'}
MAX_BYTES = 11900
# What tells a web UI from a desktop app or a terminal program (launch-discovery.cjs's, for Claude's declare_kind).
UI_PACKAGES = ('vite', 'next', 'react-scripts', 'nuxt', 'astro', '@sveltejs/kit', '@angular/cli', 'webpack-dev-server', 'parcel', 'gatsby', '@remix-run/dev', 'express', 'fastify', 'koa', 'http-server', 'serve')
APP_PACKAGES = ('electron', '@tauri-apps/cli', '@tauri-apps/api', 'nw', '@neutralinojs/lib')


def read_json(file):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 4_000_000:
        return {}
    try:
        result = json.loads(file.read_text())
        return result if isinstance(result, dict) else {}
    except (ValueError, OSError):
        return {}


def text(value, limit=300):
    return value[:limit] if isinstance(value, str) else None


def compact_railpack(info, plan):
    """Allowlist only. Never expose build assets, layers, variables or secret values."""
    metadata = info.get('metadata') or {}
    result = {'success': info.get('success') is True,
              'providers': [text(x, 40) for x in (info.get('detectedProviders') or [])[:4]],
              'metadata': {k: text(metadata[k], 80) for k in
                           ('nodePackageManager', 'nodeRuntime', 'pythonPackageManager', 'pythonRuntime') if k in metadata}}
    result['runtimes'] = {k: {f: text(v.get(f), 100) for f in ('requestedVersion', 'source')}
                          for k, v in list((info.get('resolvedPackages') or {}).items())[:4] if isinstance(v, dict)}
    result['start_hint'] = text((plan.get('deploy') or {}).get('startCommand'), 400)
    result['commands'] = {stage['name']: [text(c.get('cmd'), 240) for c in (stage.get('commands') or [])
                                        if isinstance(c, dict) and isinstance(c.get('cmd'), str)][:3]
                          for stage in (plan.get('steps') or []) if isinstance(stage, dict) and stage.get('name') in ('install', 'build')}
    result['warnings'] = [text(log.get('Msg'), 240) for log in (info.get('logs') or [])
                          if isinstance(log, dict) and log.get('Level') in ('warn', 'error')][:2]
    return result


def components():
    found, visited, truncated = [], 0, False
    for directory, children, files in os.walk(ROOT, followlinks=False):
        children[:] = sorted(c for c in children if c not in IGNORE and not (Path(directory) / c).is_symlink())
        relative = Path(directory).relative_to(ROOT)
        if len(relative.parts) >= 3:
            truncated = truncated or bool(children)
            children[:] = []
        visited += 1
        if visited > 120:
            truncated = True
            break
        names = set(files) & MANIFESTS
        if not names:
            continue
        if len(found) == 8:
            truncated = True
            break
        root = Path(directory)
        safe_names = sorted(n for n in names if not (root / n).is_symlink())
        item = {'cwd': str(relative), 'manifests': safe_names,
                'lockfiles': sorted(set(files) & LOCKS),
                'files': sorted(n for n in files if not n.startswith('.') and n not in LOCKS)[:20]}
        package_file = root / 'package.json'
        package = read_json(package_file) if package_file.exists() and package_file.stat().st_size <= 64000 else {}
        scripts = package.get('scripts') or {}
        if isinstance(scripts, dict):
            item['scripts'] = {k: text(v, 300) for k, v in scripts.items() if k in
                               ('dev', 'start', 'serve', 'preview', 'build', 'predev', 'prestart', 'prebuild', 'postinstall', 'prepare', 'backend', 'server', 'client')}
        proxy = package.get('proxy')
        if isinstance(proxy, str):
            # Retain local routing evidence, not arbitrary URLs/credentials.
            from urllib.parse import urlparse
            target = urlparse(proxy)
            if target.scheme in ('http', 'https') and target.hostname in ('localhost', '127.0.0.1', '::1') and not target.username:
                item['local_proxy'] = text(proxy, 200)
            else:
                item['proxy_configured'] = True
        for key in ('workspaces', 'engines', 'packageManager'):
            if key in package:
                item[key] = package[key] if len(json.dumps(package[key])) < 500 else '[truncated; inspect package.json]'
        hints = package_hints(package, set(files) | set(children))
        if hints:
            item['hints'] = hints
        item['evidence'] = [str(relative / n) for n in sorted(files)
                            if n.lower().startswith('readme') or n.startswith(('vite.config.', 'next.config.')) or n in ('Procfile', 'railpack.json', 'server.py', 'app.py', 'main.py', 'manage.py', 'index.html')][:8]
        found.append(item)
    return found, truncated


def package_hints(package, files):
    dependencies = {}
    for key in ('dependencies', 'devDependencies'):
        if isinstance(package.get(key), dict):
            dependencies.update(package[key])
    hints = {}
    web = [name for name in UI_PACKAGES if name in dependencies]
    app = [name for name in APP_PACKAGES if name in dependencies]
    if web:
        hints['web'] = web[:4]
    if app or 'src-tauri' in files:
        hints['desktop'] = app[:3] or ['tauri']
    if isinstance(package.get('bin'), str):
        hints['bin'] = [text(package.get('name'), 80) or 'bin']
    elif isinstance(package.get('bin'), dict):
        hints['bin'] = [text(name, 80) for name in list(package['bin'])[:4]]
    if isinstance(package.get('main'), str):
        hints['main'] = text(package['main'], 200)
    return hints


def analyze(component):
    started = time.monotonic()
    result = {'status': 'unavailable'}
    # No app credentials or inherited Railpack command overrides. Output files
    # live outside the repository; prepare generates a plan, never executes it.
    environment = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LANG') if k in os.environ}
    with tempfile.TemporaryDirectory(prefix='discovery-', dir=STATE) as directory:
        plan, info = Path(directory) / 'plan.json', Path(directory) / 'info.json'
        try:
            with tempfile.TemporaryFile() as output:
                process = subprocess.Popen(['railpack', 'prepare', str(ROOT / component['cwd']),
                                            '--plan-out', str(plan), '--info-out', str(info)],
                                           env=environment, stdout=output, stderr=output, start_new_session=True)
                try:
                    code = process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    return {'status': 'timeout', 'elapsed_ms': round((time.monotonic() - started) * 1000)}
            data, build = read_json(info), read_json(plan)
            if data:
                result = {**compact_railpack(data, build), 'status': 'planned' if code == 0 else 'incomplete',
                          'version': text(data.get('railpackVersion'), 40),
                          'raw_bytes': sum(f.stat().st_size for f in (info, plan) if f.exists())}
        except (OSError, ValueError, TypeError, KeyError):
            pass  # Unsupported/broken discovery is advisory, never a build failure.
    return {**result, 'elapsed_ms': round((time.monotonic() - started) * 1000)}


def discover():
    started = time.monotonic()
    items, truncated = components()
    # Analyze install roots, not every npm workspace child. Keep children in the
    # manifest facts so their launch scripts remain visible to the agent.
    selected = []
    for item in items:
        parent = None
        for candidate in items:
            patterns = candidate.get('workspaces')
            if isinstance(patterns, dict):
                patterns = patterns.get('packages')
            if candidate is item or 'package.json' not in item['manifests'] or not isinstance(patterns, list):
                continue
            if (ROOT / item['cwd']).is_relative_to(ROOT / candidate['cwd']):
                relative = str((ROOT / item['cwd']).relative_to(ROOT / candidate['cwd']))
                if any(isinstance(p, str) and not p.startswith('!') and fnmatch.fnmatchcase(relative, p.rstrip('/')) for p in patterns):
                    parent = candidate
                    break
        if parent:
            item['workspace_root'] = parent['cwd']
        elif len(selected) < 3:
            selected.append(item)
        else:
            item['railpack'] = {'status': 'not_analyzed', 'reason': 'bounded discovery'}
    with ThreadPoolExecutor(max_workers=3) as pool:
        for item, result in zip(selected, pool.map(analyze, selected)):
            item['railpack'] = result
    result = {'components': items, 'scan_truncated': truncated,
              'elapsed_ms': round((time.monotonic() - started) * 1000)}
    # Valid bounded JSON, not a truncated JSON string. Missing components/facts
    # are explicit; the agent must inspect them rather than assume completeness.
    while len(json.dumps(result).encode()) > MAX_BYTES and items:
        items.pop()
        result['scan_truncated'] = True
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(discover()))
    except Exception:
        print(json.dumps({'components': [], 'status': 'unavailable', 'scan_truncated': True}))

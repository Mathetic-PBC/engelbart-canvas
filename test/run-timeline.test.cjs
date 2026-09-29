const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const React = require('react');
const jsx = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const elements = [];
const runtime = { ...jsx };
for (const method of ['jsx', 'jsxs']) runtime[method] = (...args) => { const element = jsx[method](...args); elements.push(element); return element; };
const filename = path.join(__dirname, '__timeline-unit.cjs');
const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/RunTimeline.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? runtime : Module.prototype.require.call(this, id); };
compiled._compile(bundled.outputFiles[0].text, filename);
const { StepRow, RunLogs, stepSummary } = compiled.exports;
const base = { id: 'sandbox', title: 'Sandbox', state: 'done', startedAt: '2026-09-23T00:00:00Z', elapsed: 4000, since: null, error: null,
  summary: 'Sandbox running · cloned owner/app', events: [{ text: 'Cloned owner/app', kind: 'status' }] };
const render = (step = base, props = {}) => { elements.length = 0; return renderToStaticMarkup(React.createElement(StepRow, { step, index: 0, now: Date.now(), expanded: false, onToggle() {}, ...props })); };
const native = (className) => elements.find((element) => typeof element.type === 'string' && element.props.className?.split(' ').includes(className));

test('the whole step row toggles details with numbered content, status, duration, and a visible chevron', () => {
  let toggled = 0;
  const html = render(base, { onToggle: () => { toggled++; } });
  assert.match(html, /build-step-number">1<\/span>Sandbox/);
  assert.match(html, /build-state-done/);
  assert.match(html, /build-step-duration">4s/);
  assert.match(html, /build-step-chevron/);
  assert.equal(native('build-step-button').props['aria-expanded'], false);
  assert.equal(native('build-step-button').props.title, undefined);
  native('build-step-button').props.onClick();
  assert.equal(toggled, 1);
});

test('skipped steps without details have no expansion affordance', () => {
  const html = render({ ...base, state: 'skipped', events: [], startedAt: null });
  assert.match(html, /build-state-skipped/);
  assert.equal(native('build-step-button').props.disabled, true);
  assert.equal(native('build-step-button').props.onClick, undefined);
  assert.doesNotMatch(html, /aria-expanded|aria-controls|build-step-chevron|build-step-output/);
});

test('closing hides rather than unmounts each log, so internal scroll state survives', () => {
  const closed = render();
  assert.match(closed, /class="build-step-output" hidden=""/);
  assert.match(closed, /Cloned owner\/app/);
  const opened = render(base, { expanded: true });
  assert.match(opened, /aria-expanded="true"/);
  assert.doesNotMatch(opened, /class="build-step-output" hidden/);
  assert.match(opened, /class="build-log" tabindex="0"/);
});

test('warnings use an exclamation, failures an error icon, and running steps a spinner', () => {
  const warning = render({ ...base, state: 'warned', summary: 'Initial setup failed', error: 'Missing dependency' }, { expanded: true });
  assert.match(warning, /build-state-warned/);
  assert.match(warning, /d="M12 5v8m0 5h.01"/);
  assert.doesNotMatch(warning, /d="M20 6 9 17l-5-5"/);
  assert.match(warning, /role="alert" class="build-step-error">Missing dependency/);
  assert.match(render({ ...base, state: 'failed' }), /build-state-failed/);
  assert.match(render({ ...base, state: 'active' }), /build-state-active/);
});

test('Live details use the supplied preview callback without creating another navigation path', () => {
  let opened = 0;
  const html = render({ ...base, id: 'live', title: 'Live', summary: 'Preview ready' }, { expanded: true, onOpenPreview: () => { opened++; } });
  assert.match(html, />Open preview ↗<\/button>/);
  native('build-preview-link').props.onClick();
  assert.equal(opened, 1);
  assert.doesNotMatch(render({ ...base, id: 'live' }), /build-preview-link/);
});

test('expanded logs are bounded, indented, readable, and horizontally scrollable without forced wrapping', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/run-timeline.css'), 'utf8');
  assert.match(css, /max-height:min\(220px,35dvh\);overflow:auto;overscroll-behavior:contain/);
  assert.match(css, /padding:8px 22px 8px 50px;font:12px\/1\.6/);
  assert.match(css, /white-space:pre;overflow-wrap:normal/);
  assert.doesNotMatch(css, /font-style:italic/);
  assert.match(css, /build-step-chevron\{[^}]*opacity:\.55/);
  assert.match(css, /build-step-skipped \.build-step-summary/);
});

test('completed copy is concise without changing step outcomes, unknowns, or original event text', () => {
  const setup = { ...base, id: 'start', title: 'Install and start', summary: 'Set up: dependencies installed',
    events: [{ text: 'Installed dependencies and prepared the repository.', kind: 'status', data: { phase: 'setup', status: 'done' } }] };
  const before = JSON.stringify(setup);
  assert.equal(stepSummary(setup), 'Repository prepared');
  assert.equal(stepSummary({ ...setup, title: 'Restart application' }), 'Application restarted');
  assert.equal(stepSummary({ ...setup, state: 'warned', summary: 'Recovered after setup failure' }), 'Recovered after setup failure');
  assert.equal(stepSummary({ ...setup, state: 'failed', summary: 'Setup failed' }), 'Setup failed');
  assert.equal(stepSummary({ ...setup, state: 'active', summary: 'Installing and preparing…' }), 'Installing and preparing…');
  assert.equal(stepSummary({ ...setup, events: [], summary: 'Installing and preparing…' }), 'Setup activity recorded');
  assert.equal(stepSummary({ ...base, summary: 'Sandbox running · cloning owner/app…' }), 'Sandbox running');
  assert.equal(stepSummary({ ...base, state: 'active', summary: 'Sandbox running · cloning owner/app…' }), 'Sandbox running · cloning owner/app…');
  assert.equal(stepSummary({ ...base, id: 'health', summary: 'The check passed' }), 'Check passed');
  assert.equal(stepSummary({ ...base, id: 'health', state: 'skipped', summary: 'Not recorded' }), 'Not recorded');
  assert.equal(JSON.stringify(setup), before);
  const html = render(setup, { expanded: true });
  assert.match(html, /title="Repository prepared">Repository prepared</);
  assert.match(html, /Installed dependencies and prepared the repository\./);
  assert.match(html, /build-step-duration">4s/);
});

test('Logs reuses normalized chronological output, including progress updates and meaningful errors', () => {
  const run = { id: 'run', status: 'failed', error: 'Install failed', build_log: [
    { time: '2026-09-23T00:00:00Z', message: 'npm ci', kind: 'command', data: { stage: 'install' } },
    { time: '2026-09-23T00:00:01Z', message: 'Resolving: 41%\rResolving: 100%\n', kind: 'stdout', data: { phase: 'log', stage: 'install' } },
    { time: '2026-09-23T00:00:02Z', message: 'Missing package\n', kind: 'stderr', data: { phase: 'log', stage: 'install' } },
  ] };
  const before = JSON.stringify(run);
  const html = renderToStaticMarkup(React.createElement(RunLogs, { run }));
  assert.match(html, /build-log build-log-full/);
  assert.match(html, /Resolving: 100%/);
  assert.doesNotMatch(html, /Resolving: 41%/);
  assert.ok(html.indexOf('npm ci') < html.indexOf('Resolving: 100%'));
  assert.match(html, /Missing package/);
  assert.match(html, /role="alert"[^>]*>Install failed/);
  assert.equal(JSON.stringify(run), before);
  assert.match(renderToStaticMarkup(React.createElement(RunLogs)), /Logs will appear when setup starts/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/run-timeline.css'), 'utf8');
  assert.match(css, /\.build-log-full\{flex:1;min-height:0;max-height:none/);
});

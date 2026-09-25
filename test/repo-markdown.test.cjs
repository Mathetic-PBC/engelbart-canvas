'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '__repo-readme-unit.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/RepoReadme.jsx')], bundle: true, platform: 'node',
  format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
const elements = [];
const recordingRuntime = { ...jsxRuntime };
for (const method of ['jsx', 'jsxs']) recordingRuntime[method] = (...args) => {
  const element = jsxRuntime[method](...args);
  elements.push(element);
  return element;
};
let loadedReadme;
const fixtureReact = { ...React, useState: (initial) => React.useState(loadedReadme && initial?.status === 'loading' ? loadedReadme : initial) };
compiled.require = function (id) {
  if (id === 'react') return fixtureReact;
  if (id === 'react/jsx-runtime') return recordingRuntime;
  return Module.prototype.require.call(this, id);
};
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: RepoReadme, ReadmeContent, readmeUrl } = compiled.exports;
const readme = { path: '.github/README.md', htmlUrl: 'https://github.com/owner/app/blob/main/.github/README.md',
  rawUrl: 'https://raw.githubusercontent.com/owner/app/main/.github/README.md', format: 'markdown' };
const render = (content, extra = {}) => renderToStaticMarkup(React.createElement(ReadmeContent, { readme: { ...readme, content, ...extra } }));

test('README titles and opening paragraphs stay in their original order without injected actions or layout wrappers', () => {
  for (const content of ['# Title\n\nBody\n\n# Later title', 'Title\n=====\n\nBody', '<div align="center"><h1>Title</h1><p>Body</p></div>']) {
    const html = render(content);
    assert.match(html, /<h1[^>]*>Title<\/h1>\s*<p>Body<\/p>/);
    assert.doesNotMatch(html, /<button|repo-inline-actions|repo-readme-intro|engelbart-repo-/);
  }
});

test('title-less, empty and plain-text READMEs have no injected app controls', () => {
  for (const content of ['', 'Introduction\n\n## Setup', '> # Quoted title\n\nBody', '<details><summary>More</summary><h1>Hidden title</h1></details>']) {
    assert.doesNotMatch(render(content), /<button|repo-inline-actions|repo-readme-intro|engelbart-repo-/);
  }
  assert.match(render('# Literal title', { format: 'text' }), /<article[^>]*><pre class="repo-readme-plain"># Literal title<\/pre>/);
});

test('README content retains paper links, media coverage and figures without application chrome', () => {
  const html = render('# Title ([Paper](https://example.org/paper)) ([Arxiv](https://arxiv.org/abs/1234.56789))\n\nTOCHI 2025. Media Coverage: [News](https://example.org/news)\n\n![Figure](figure.png)');
  assert.match(html, /href="https:\/\/example.org\/paper">Paper<\/a>/);
  assert.match(html, /href="https:\/\/arxiv.org\/abs\/1234.56789">Arxiv<\/a>/);
  assert.match(html, /<p>TOCHI 2025\. Media Coverage: <a href="https:\/\/example.org\/news">News<\/a><\/p>/);
  assert.match(html, /src="https:\/\/raw.githubusercontent.com\/owner\/app\/main\/.github\/figure.png"/);
  assert.doesNotMatch(html, /<button|repo-toolbar|repo-inline-actions|repo-readme-intro/);
});

test('README renders Markdown headings, code, tables, lists and safe raw HTML', () => {
  const html = render('# Hello\n\n**Bold** and `code`\n\n## Install\n\n```sh\nnpm install\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n- [x] Done\n- [ ] Next\n\n<details><summary>More</summary>Useful details</details>');
  assert.match(html, /<h1 id="repo-readme-hello">Hello<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<pre><code class="language-sh">npm install\n<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>Name<\/th>/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
  assert.match(html, /<details><summary>More<\/summary>Useful details<\/details>/);
});

test('relative links, root paths, badges and images retain the repository and branch', () => {
  assert.equal(readmeUrl('../docs/setup.md', 'href', readme), 'https://github.com/owner/app/blob/main/docs/setup.md');
  assert.equal(readmeUrl('/assets/logo.png', 'src', readme), 'https://raw.githubusercontent.com/owner/app/main/assets/logo.png');
  assert.equal(readmeUrl('https://github.com/owner/app/blob/main/logo.svg', 'src', readme), 'https://raw.githubusercontent.com/owner/app/main/logo.svg');
  assert.equal(readmeUrl('#install', 'href', readme), '#install');
  const html = render('[Guide](../docs/setup.md) ![Logo](../assets/logo.png)\n\n<picture><source srcset="../small.png 1x, ../large.png 2x"><img alt="Badge" src="https://img.shields.io/badge/build-passing-black"></picture>');
  assert.match(html, /href="https:\/\/github.com\/owner\/app\/blob\/main\/docs\/setup.md"/);
  assert.match(html, /src="https:\/\/raw.githubusercontent.com\/owner\/app\/main\/assets\/logo.png"/);
  assert.match(html, /loading="lazy" referrerPolicy="no-referrer"/);
  assert.match(html, /srcSet="https:\/\/raw.githubusercontent.com\/owner\/app\/main\/small.png 1x, https:\/\/raw.githubusercontent.com\/owner\/app\/main\/large.png 2x"/);
});

test('untrusted README cannot inject scripts, frames, handlers, styles or executable links', () => {
  const html = render('<script>alert(1)</script><iframe src="https://evil.example"></iframe><style>body{display:none}</style>\n\n<img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)" onclick="alert(1)">Bad</a><img src="file:///etc/passwd"><picture><source srcset="data:text/html,bad 1x, file:///secret 2x"></picture>\n\n<div id="root" style="position:fixed">Safe text</div>');
  assert.doesNotMatch(html, /<script|<iframe|<style|onerror|onclick|style=|href="javascript|src="(?:javascript|file|data):|srcSet="(?:data|file):|id="root"/i);
  assert.match(html, /id="user-content-root"/);
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'https://user:secret@example.org', '\u0000https://evil.example']) {
    assert.equal(readmeUrl(value, 'href', readme), '');
    assert.equal(readmeUrl(value, 'src', readme), '');
  }
});

test('duplicate heading anchors are GitHub-compatible and non-Markdown files remain literal', () => {
  const html = render('## Set up\n\n## Set up\n\n[Jump](#set-up-1)');
  assert.match(html, /id="repo-readme-set-up"/);
  assert.match(html, /id="repo-readme-set-up-1"/);
  assert.match(html, /href="#set-up-1"/);
  const plain = render('<script>not executable</script>', { format: 'text' });
  assert.match(plain, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(plain, /<script>/);
});

test('README images do not loosen script, connection, frame or object CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(html, /img-src 'self' data: blob: https:/);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /connect-src 'self';/);
  assert.match(html, /frame-src 'none'; object-src 'none';/);
});

test('README web links navigate in Stage while section anchors stay inside the README', () => {
  const navigations = [];
  const previousWindow = global.window;
  global.window = { dispatchEvent: (event) => navigations.push([event.type, event.detail]) };
  loadedReadme = { ...readme, status: 'ready', content: '## Setup\n\n[Repository](https://github.com/owner/app) [Docs](https://docs.example.org/) [Jump](#setup)' };
  elements.length = 0;
  try {
    renderToStaticMarkup(React.createElement(RepoReadme, { repo: { id: 'repo' } }));
    for (const href of ['https://github.com/owner/app', 'https://docs.example.org/']) {
      const link = elements.find((element) => element.type === 'a' && element.props.href === href);
      for (const handler of ['onClick', 'onAuxClick']) {
        let prevented = false;
        link.props[handler]({ button: 1, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.deepEqual(navigations.at(-1), ['engelbart:open-in-browser', { url: href }]);
      }
    }
    assert.equal(navigations.length, 4);
    elements.find((element) => element.type === 'a' && element.props.href === '#setup').props.onClick({ preventDefault() {} });
    assert.equal(navigations.length, 4, 'Section anchors do not open Stage');
  } finally {
    loadedReadme = undefined;
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
  }
});

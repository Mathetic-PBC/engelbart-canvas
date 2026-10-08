'use strict';

// npx electron scripts/smoke-connect-browser.cjs
// The agents' browser of Connect your library (src/main/connect/browser.cjs) in real Electron, hidden, against a page
// served on this machine: it opens only its job's sites (a link, a new window and browser_open elsewhere are refused and
// logged), reads the page's text and controls with refs (a password field's value never), types into a field and into an
// editor (contenteditable, as ChatGPT's and Claude's composers are), refuses to type into a password field, clicks, waits
// for text, runs a script in the page (a same-origin fetch, with the page's cookies), takes a picture, downloads a file
// with the session's cookies, and never shows a window when headless. Then ChatGPT's listing script
// (src/main/connect/web-chats.cjs) runs against a fake of the endpoints its page uses.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAgentBrowser } = require('../src/main/connect/browser.cjs');
const { listWebChats, readWebChat } = require('../src/main/connect/web-chats.cjs');

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-agent-browser-')));
app.setPath('userData', path.join(scratch, 'electron'));

const PAGE = `<!doctype html><meta charset="utf-8"><title>Agent page</title>
<h1>Research drive</h1>
<div role="row" data-id="file-111" aria-label="Thesis draft, Google Docs">Thesis draft</div>
<div role="row" data-id="file-222" aria-label="Budget, Google Sheets">Budget</div>
<input name="q" placeholder="Search drive">
<input type="password" name="secret" value="hunter2" aria-label="Password">
<div contenteditable="true" aria-label="Message" id="composer"></div>
<button id="go" onclick="document.getElementById('out').textContent='Clicked!'">Go</button>
<p id="out"></p>
<a href="/next">Next page</a>
<a id="away" href="http://localhost:PORT2/">Elsewhere</a>`;

app.whenReady().then(async () => {
  let server, other;
  try {
    other = http.createServer((req, res) => { res.end('elsewhere'); });
    await new Promise((resolve) => { other.listen(0, '127.0.0.1', resolve); });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=abc; Path=/' }); res.end(PAGE.replace('PORT2', String(other.address().port))); return; }
      if (url.pathname === '/next') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Next</title><p>Second page</p>'); return; }
      if (url.pathname === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cookie: req.headers.cookie || '' })); return; }
      if (url.pathname === '/export.md') { res.writeHead(200, { 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="Thesis draft.md"' }); res.end(`# Thesis draft\ncookie: ${req.headers.cookie || ''}\n`); return; }
      // ChatGPT's endpoints, as its own page asks them
      if (url.pathname === '/api/auth/session') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accessToken: 'tok', user: { email: 'me@example.org' } })); return; }
      if (url.pathname === '/backend-api/conversations') {
        assert.equal(req.headers.authorization, 'Bearer tok');
        const offset = Number(url.searchParams.get('offset'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(offset === 0 ? { items: [{ id: 'conv-1111', title: 'Study design', update_time: '2026-10-06T00:00:00Z' }, { id: 'conv-2222', title: 'Recipes', update_time: '2026-01-01T00:00:00Z' }], total: 3 } : { items: offset === 2 ? [{ id: 'conv-3333', title: 'Help-seeking', update_time: '2026-10-05T00:00:00Z' }] : [], total: 3 }));
        return;
      }
      if (url.pathname === '/backend-api/conversation/conv-1111') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: 'Study design', update_time: 1791000000, current_node: 'b', mapping: { r: { parent: null, message: null }, a: { parent: 'r', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['How many participants?'] } } }, b: { parent: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Twenty.'] } } } } })); return; }
      res.writeHead(404); res.end('not found');
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const log = [];
    const browsing = session.fromPartition(`persist:agent-smoke-${process.pid}`);
    const browser = createAgentBrowser({ BrowserWindow, getSession: () => browsing, log: (jobId, text) => log.push(text), headless: true });
    const job = { id: 'job-1', label: 'Smoke', sites: ['127.0.0.1'] };
    const page = browser.tools(job);

    const opened = await page.open(`${base}/`);
    assert.equal(opened.title, 'Agent page');
    assert.equal(BrowserWindow.getAllWindows().filter((win) => win.isVisible()).length, 0, 'nothing is ever shown');
    const read = await page.read();
    assert.match(read.text, /Research drive/);
    const byName = (name) => read.elements.find((el) => el.name === name);
    assert.equal(byName('Thesis draft, Google Docs').id, 'file-111', 'a Drive row\'s id is read');
    assert.equal(byName('Password').password, true);
    assert.equal(byName('Password').value, undefined, 'a password field\'s value is never read');
    assert.equal(byName('Next page').href, `${base}/next`);

    await page.type(byName('Search drive').ref, 'thesis');
    assert.equal(await page.evaluate("return document.querySelector('input[name=q]').value"), 'thesis');
    await page.type(byName('Message').ref, 'What do you remember about me?');
    assert.equal(await page.evaluate("return document.getElementById('composer').textContent"), 'What do you remember about me?', 'typed into an editor');
    await assert.rejects(page.type(byName('Password').ref, 'x'), /password field/);
    await page.click(byName('Go').ref);
    assert.deepEqual(await page.wait({ untilText: 'Clicked!', seconds: 5 }), { done: true, after: 0 });

    const fetched = await page.evaluate("return await (await fetch('/api/data')).json()");
    assert.equal(fetched.cookie, 'sid=abc', 'the page\'s own fetch carries its cookies');
    const picture = await page.screenshot();
    assert.ok(picture.data.length > 1000 && picture.mimeType === 'image/jpeg', 'a picture of the page');
    const saved = await page.download(`${base}/export.md`, path.join(scratch, 'downloads'));
    assert.equal(path.basename(saved.path), 'Thesis draft.md');
    assert.match(fs.readFileSync(saved.path, 'utf8'), /cookie: sid=abc/, 'downloaded with the session\'s cookies');

    // Only its sites: browser_open, a link and a download elsewhere are refused.
    await assert.rejects(page.open('https://example.com/'), /not one of the sites/);
    await assert.rejects(page.download(`http://localhost:${other.address().port}/`, scratch), /not one of the sites/);
    const away = (await page.read()).elements.find((el) => el.name === 'Elsewhere');
    await page.click(away.ref);
    await new Promise((resolve) => { setTimeout(resolve, 800); });
    assert.equal(new URL(page.url()).host, `127.0.0.1:${server.address().port}`, 'the link elsewhere was not followed');
    assert.ok(log.some((line) => /Kept away from localhost/.test(line)), log.join(' | '));
    await page.click((await page.read()).elements.find((el) => el.name === 'Next page').ref);
    assert.deepEqual(await page.wait({ untilText: 'Second page', seconds: 5 }).then((out) => out.done), true, 'a link on its own site is followed');
    assert.equal(browser.show(job.id, { title: 'Sign in' }), false, 'headless: never shown');
    assert.ok(log.includes('Opened 127.0.0.1') && log.some((line) => /^Typed into “Search drive”/.test(line)) && log.some((line) => /^Clicked “Go”/.test(line)), log.join(' | '));

    // ChatGPT's listing and reading scripts, against the same endpoints on this page's origin.
    const chatPage = { ...page, ensure: () => page.open(`${base}/`) };
    const listed = await listWebChats(chatPage, 'ChatGPT', { days: 30 });
    assert.equal(listed.account, 'me@example.org');
    assert.deepEqual(listed.chats.map((chat) => chat.id), ['conv-1111', 'conv-3333'], 'every page of the list read, the old one left out');
    const chat = await readWebChat(chatPage, 'ChatGPT', 'conv-1111');
    assert.deepEqual(chat.turns, [{ role: 'user', text: 'How many participants?' }, { role: 'assistant', text: 'Twenty.' }]);

    browser.closeAll();
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'its windows are gone');
    console.log(`The agents' browser smoke passed (${log.length} steps logged).`);
    server.close(); other.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (server) server.close();
    if (other) other.close();
    app.exit(1);
  }
});

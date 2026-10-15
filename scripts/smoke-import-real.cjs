'use strict';

// npm run build && npx electron scripts/smoke-import-real.cjs
// Import your context with the real agents (2026-10-15: every smoke used Connect's fake agents, so "tools.ensure is not a
// function" failed every real import while they all passed, and the person saw "Nothing new came into your Engelbart
// Library"). The app's own main process, hidden, on a disposable home (ENGELBART_HOME_DIR) holding an Obsidian vault and
// a folder of papers about one project; the person's real Claude Code (or Codex: ENGELBART_REAL_PROVIDER=openai) runs the
// agents. A background run of those two sources must bring notes and PDFs in, with no job failed. It costs a few model
// turns. ENGELBART_REAL_TIMEOUT_S (default 600) bounds it.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDER = process.env.ENGELBART_REAL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-import-real-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: false });
const write = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// The vault: research notes on the project, and a personal folder the agent should leave out.
write('Notes/.obsidian/app.json', '{}');
write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { v: { path: path.join(root, 'Notes'), ts: Date.now(), open: true } } }));
write('Notes/Research/Help-seeking in novice programmers.md', '# Help-seeking in novice programmers\nNovices rarely ask for help; when they do, they ask about syntax, not design. Pilot 2 had 12 participants.\n');
write('Notes/Research/Study design.md', '# Study design\nA randomized trial of an AI tutor that withholds answers and asks students to explain their code first.\n');
write('Notes/Personal/Groceries.md', 'Milk, eggs, coffee.\n');
// Two papers on it: one-page PDFs with a title and text.
const pdf = (title) => {
  const content = `BT /F1 18 Tf 72 720 Td (${title}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, n) => { offsets.push(body.length); body += `${n + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (${title}) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
};
write('Papers/Help-seeking behavior of novice programmers.pdf', pdf('Help-seeking behavior of novice programmers'));
write('Papers/Intelligent tutoring systems and help-seeking.pdf', pdf('Intelligent tutoring systems and help-seeking'));

require('../src/main/index.cjs');

const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (wc, expression) => wc.executeJavaScript(expression, true);

app.whenReady().then(async () => {
  const limit = Date.now() + (Number(process.env.ENGELBART_REAL_TIMEOUT_S) || 600) * 1000;
  try {
    let win = null;
    while (!win && Date.now() < limit) { win = BrowserWindow.getAllWindows()[0] || null; await pause(); }
    assert.ok(win, 'the app window');
    win.setFocusable(false);
    const wc = win.webContents;
    while (!(await js(wc, '!!(window.engelbartAPI && window.engelbartAPI.connectStart)').catch(() => false))) { if (Date.now() > limit) throw new Error('the window\'s API never came'); await pause(); }
    const input = {
      provider: PROVIDER,
      permissions: { files: true, browser: true, recall: false, notes: false },
      keychain: false,
      browser: null,
      direct: {
        mode: 'auto',
        projects: [{ id: 'help-seeking', title: 'Help-seeking study', description: 'A randomized trial of an AI tutor that makes novice programmers explain their code before it helps.' }],
        roles: ['Researcher'],
        work: 'Learning sciences research on novice programmers',
        apps: ['Obsidian', 'PDFs on this Mac'],
        scopes: { 'PDFs on this Mac': { kind: 'folders', folders: [path.join(root, 'Papers')], people: [], items: [], labels: [], projects: [], note: '' } },
        additional: [],
      },
    };
    const started = await js(wc, `window.engelbartAPI.connectStart(${JSON.stringify(input)})`);
    console.log(`Started ${started.id} on ${PROVIDER}`);
    let state = started;
    const ended = (job) => ['done', 'failed', 'stopped'].includes(job.status);
    let seen = 0;
    while (Date.now() < limit) {
      state = await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(started.id)})`);
      for (const entry of state.log.slice(seen)) console.log(`  ${entry.at.slice(11, 19)} ${entry.text}`);
      seen = state.log.length;
      const work = state.jobs.filter((job) => job.kind === 'import');
      if (state.finished && work.length && work.every(ended) && !['writing', 'queued'].includes(state.memory.status)) break;
      if (state.blocked) throw new Error(`Waiting for ${state.blocked.name}: ${state.blocked.error}`);
      await pause(2000);
    }
    const imports = state.jobs.filter((job) => job.kind === 'import');
    for (const job of imports) console.log(`${job.label}: ${job.status}, ${job.notes} notes, ${job.items} items${job.error ? `, ${job.error}` : ''}${job.summary ? ` | ${job.summary}` : ''}`);
    assert.ok(imports.length >= 2, 'an import a source');
    assert.deepEqual(imports.filter((job) => job.status === 'failed').map((job) => `${job.label}: ${job.error}`), [], 'no import failed');
    assert.ok(imports.every(ended), 'every import ended in time');
    const obsidian = imports.find((job) => job.apps.includes('Obsidian'));
    const pdfs = imports.find((job) => job.apps.includes('PDFs on this Mac'));
    assert.ok(obsidian && obsidian.notes >= 1, `notes came in from the vault: ${obsidian && obsidian.summary}`);
    assert.ok(pdfs && pdfs.items >= 1, `PDFs came in: ${pdfs && pdfs.summary}`);
    // The notes are Markdown files of the library's own (assets/md, stored by id): their text, never the personal one.
    const md = path.join(root, '.engelbart', 'assets', 'md');
    const texts = fs.existsSync(md) ? fs.readdirSync(md, { recursive: true }).map((name) => path.join(md, String(name))).filter((file) => file.endsWith('.md') && fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'utf8')) : [];
    assert.ok(texts.some((text) => /Novices rarely ask for help/.test(text)), `the vault's notes are in the library (${texts.length} files)`);
    assert.ok(!texts.some((text) => /Milk, eggs, coffee/.test(text)), 'nothing personal came in');
    console.log(`smoke-import-real (${PROVIDER}): ok (${obsidian.notes} notes, ${pdfs.items} PDFs)`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

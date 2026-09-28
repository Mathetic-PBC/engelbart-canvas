'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');

test('post-its survive database reopening, stay in their project, and deletion cannot be undone by a late save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-post-its-'));
  try {
    for (const name of ['a', 'b']) fs.mkdirSync(path.join(root, name));
    const a = await db.openNotesDb(path.join(root, 'a'));
    const b = await db.openNotesDb(path.join(root, 'b'));
    assert.ok(a.postIts, 'the project database exposes post-its');
    const id = randomUUID();
    await a.postIts.create({ id, text: '', nx: .5, ny: .25, width: 300, height: 240, z: 1 });
    await a.postIts.update(id, { text: '**Keep this**\n- across launches', nx: .9, ny: .8, width: 420, height: 320, z: 2 });
    assert.deepEqual(await b.postIts.list(), []);
    assert.deepEqual(await a.list(), [], 'post-its are not ordinary titled notes');
    await a.close();
    const reopened = await db.openNotesDb(path.join(root, 'a'));
    const [card] = await reopened.postIts.list();
    assert.deepEqual([card.id, card.text, card.nx, card.ny, card.width, card.height, card.z], [id, '**Keep this**\n- across launches', .9, .8, 420, 320, 2]);
    await assert.rejects(reopened.postIts.update(id, { ...card, width: NaN }), /width/);
    await assert.rejects(reopened.postIts.update(id, { ...card, nx: 2 }), /nx/);
    await assert.rejects(reopened.postIts.update(id, { ...card, text: 'x'.repeat(400001) }), /text/);
    assert.equal(await reopened.postIts.remove(id), true);
    assert.equal(await reopened.postIts.update(id, card), null);
    assert.deepEqual(await reopened.postIts.list(), []);
  } finally {
    await db.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('window clamping preserves preferred geometry and scales native bounds with zoom', () => {
  const { cardBounds, layoutFromBounds } = require('../src/main/post-its/geometry.cjs');
  const layout = { nx: 1, ny: 1, width: 600, height: 500 };
  assert.deepEqual(cardBounds(layout, { width: 400, height: 300 }, 1), { x: 8, y: 56, width: 384, height: 236 });
  assert.deepEqual(layout, { nx: 1, ny: 1, width: 600, height: 500 });
  assert.deepEqual(cardBounds(layout, { width: 1200, height: 900 }, 1), { x: 592, y: 392, width: 600, height: 500 });
  const normal = cardBounds({ nx: .5, ny: .5, width: 300, height: 240 }, { width: 1000, height: 800 }, 1);
  assert.deepEqual(cardBounds({ nx: .5, ny: .5, width: 300, height: 240 }, { width: 2000, height: 1600 }, 2), { x: normal.x * 2, y: normal.y * 2, width: 600, height: 480 });
  assert.deepEqual(layoutFromBounds({ x: 592, y: 392, width: 600, height: 500 }, { width: 1200, height: 900 }, 1), layout);
});

test('a post-it is thrown away over the sidebar trash can as the renderer measured it, at any zoom (2026-09-22)', () => {
  const { inTrash, trashRect } = require('../src/main/post-its/geometry.cjs');
  const can = trashRect({ x: 40, y: 800, width: 72, height: 72 });
  assert.equal(inTrash({ x: 60, y: 820 }, can, 1), true);
  assert.equal(inTrash({ x: 30, y: 820 }, can, 1), false, 'left of the can');
  assert.equal(inTrash({ x: 60, y: 880 }, can, 1), false, 'under the can');
  assert.equal(inTrash({ x: 120, y: 1640 }, can, 2), true, 'window pixels are the rect times the zoom');
  assert.equal(inTrash({ x: 60, y: 820 }, null, 1), false, 'no workspace on screen: no trash');
  assert.equal(trashRect(null), null);
  assert.throws(() => trashRect({ x: 0, y: 0, width: NaN, height: 10 }), /trash rect/);
  assert.throws(() => trashRect({ x: 0, y: 0, width: 0, height: 10 }), /trash rect/);
});

test('the trash keeps a card restorable for a week, then purges it (2026-09-22)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-post-it-trash-'));
  try {
    const a = await db.openNotesDb(root);
    const row = (id, z) => ({ id, text: `card ${z}`, nx: .1, ny: .1, width: 260, height: 260, z });
    const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of [one, two, three].entries()) await a.postIts.create(row(id, i + 1));
    assert.ok(await a.postIts.trash(one));
    assert.equal(await a.postIts.trash(one), null, 'already in the trash');
    assert.deepEqual((await a.postIts.list()).map((r) => r.id), [two, three]);
    assert.deepEqual((await a.postIts.trashed()).map((r) => r.id), [one]);
    // A late save of a trashed card keeps its text and leaves it in the trash.
    await a.postIts.update(one, { ...row(one, 1), text: 'last words' });
    assert.equal((await a.postIts.trashed())[0].text, 'last words');
    assert.equal(await a.postIts.purge(Date.now() - 7 * 864e5), 0, 'thrown away just now: kept');
    assert.ok(await a.postIts.restore(one));
    assert.deepEqual((await a.postIts.list()).map((r) => r.id).sort(), [one, two, three].sort());
    await a.postIts.trash(two);
    await a.postIts.trash(one);
    await db.closeAll();
    // Backdate the throw directly in the table, as a week passing would.
    const { PGlite } = require('@electric-sql/pglite');
    const raw = new PGlite(path.join(root, 'notes.pglite'));
    await raw.query("update post_its set deleted = now() - interval '8 days' where id = $1", [two]);
    await raw.close();
    const b = await db.openNotesDb(root);
    assert.equal(await b.postIts.purge(Date.now() - 7 * 864e5), 1, 'a week and a day in the trash: gone');
    assert.deepEqual((await b.postIts.trashed()).map((r) => r.id), [one]);

  } finally {
    await db.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a card crumples as it nears the trash and slides clear of the can (2026-09-22)', () => {
  const { crumpleAmount, draggedBounds, SMALLEST, REACH } = require('../src/main/post-its/geometry.cjs');
  const can = { x: 40, y: 800, width: 72, height: 72 };
  assert.equal(crumpleAmount({ x: 76, y: 836 }, can), 1, 'over the can');
  assert.equal(crumpleAmount({ x: 112 + REACH + 1, y: 836 }, can), 0, 'out of reach');
  const mid = crumpleAmount({ x: 112 + REACH / 2, y: 836 }, can);
  assert.ok(mid > 0 && mid < 1);
  assert.equal(crumpleAmount({ x: 76, y: 836 }, null), 0, 'no can on screen');
  const size = { width: 260, height: 260 }, grab = { x: .5, y: .1 };
  const far = draggedBounds({ point: { x: 600, y: 300 }, grab, size, t: 0, rect: can });
  assert.deepEqual(far, { scale: 1, bounds: { x: 470, y: 274, width: 260, height: 260 } }, 'the grabbed spot stays under the pointer');
  const over = draggedBounds({ point: { x: 76, y: 836 }, grab, size, t: 1, rect: can });
  assert.equal(over.scale, SMALLEST);
  assert.equal(over.bounds.width, Math.round(260 * SMALLEST));
  assert.ok(over.bounds.x >= can.x + can.width, 'the crumpled card does not cover the can');
  const zoomed = draggedBounds({ point: { x: 152, y: 1672 }, grab, size: { width: 520, height: 520 }, t: 1, rect: can, zoom: 2 });
  assert.ok(zoomed.bounds.x >= (can.x + can.width) * 2, 'the can is in CSS px, the view in DIPs');
});

test('a growing card keeps its top edge until the window bottom stops it; overlaps and blocking rects (2026-09-22)', () => {
  const { grown, cardBounds, overlaps, blockingRects, tallest } = require('../src/main/post-its/geometry.cjs');
  const vp = { width: 1200, height: 900 };
  const row = { nx: .5, ny: .2, width: 260, height: 260 };
  const before = cardBounds(row, vp);
  const taller = { ...row, ...grown(row, 400, vp) };
  const after = cardBounds(taller, vp);
  assert.deepEqual([after.x, after.y, after.height], [before.x, before.y, 400]);
  const low = { nx: .5, ny: 1, width: 260, height: 260 };
  const pushed = cardBounds({ ...low, ...grown(low, 500, vp) }, vp);
  assert.equal(pushed.y + pushed.height, 900 - 8, 'at the bottom it grows upwards');
  assert.equal(grown(row, 5000, vp).height, tallest(vp), 'never taller than the window allows');
  assert.equal(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }), false, 'touching is not overlapping');
  assert.equal(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 5, height: 5 }), true);
  assert.deepEqual(blockingRects([]), []);
  assert.deepEqual(blockingRects([{ x: 1, y: 2, width: 3, height: 4, cover: true }, { x: 1, y: 2, width: 3, height: 4, cover: 'yes' }]), [{ x: 1, y: 2, width: 3, height: 4, cover: true }, { x: 1, y: 2, width: 3, height: 4 }], 'a covering panel is marked, and only by true');
  assert.throws(() => blockingRects(new Array(65).fill({ x: 0, y: 0, width: 1, height: 1 })), /at most 64/);
});

test('+Note names the note after the card’s first words', () => {
  const { noteName } = require('../src/main/post-its/views.cjs');
  assert.equal(noteName('# **Revisit** the migration\nmore'), 'Revisit the migration');
  assert.equal(noteName('\n\n- [ ] call [Sydney](https://x.y) about `fellowship`'), 'call Sydney about fellowship');
  assert.equal(noteName('```\ncode first\n```\nthen words'), 'then words');
  assert.equal(noteName('   \n![Attachment 1](img:abc)\n'), null);
  assert.equal(noteName(''), null);
  const long = noteName('word '.repeat(30));
  assert.ok(long.length <= 60 && !long.endsWith(' '));
});

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
  const { cardBounds, layoutFromBounds, inTrash } = require('../src/main/post-its/geometry.cjs');
  const layout = { nx: 1, ny: 1, width: 600, height: 500 };
  assert.deepEqual(cardBounds(layout, { width: 400, height: 300 }, 1), { x: 8, y: 56, width: 384, height: 236 });
  assert.deepEqual(layout, { nx: 1, ny: 1, width: 600, height: 500 });
  assert.deepEqual(cardBounds(layout, { width: 1200, height: 900 }, 1), { x: 592, y: 392, width: 600, height: 500 });
  const normal = cardBounds({ nx: .5, ny: .5, width: 300, height: 240 }, { width: 1000, height: 800 }, 1);
  assert.deepEqual(cardBounds({ nx: .5, ny: .5, width: 300, height: 240 }, { width: 2000, height: 1600 }, 2), { x: normal.x * 2, y: normal.y * 2, width: 600, height: 480 });
  assert.deepEqual(layoutFromBounds({ x: 592, y: 392, width: 600, height: 500 }, { width: 1200, height: 900 }, 1), layout);
  assert.equal(inTrash({ x: 40, y: 850 }, { width: 1200, height: 900 }, 1), true);
  assert.equal(inTrash({ x: 500, y: 850 }, { width: 1200, height: 900 }, 1), false);
  assert.equal(inTrash({ x: 40, y: 950 }, { width: 1200, height: 900 }, 1), false);
});

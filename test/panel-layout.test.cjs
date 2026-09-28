const test = require('node:test');
const assert = require('node:assert/strict');

test('right panel can cover the whole editor and be dragged back', async () => {
  const { panelSplit } = await import('../src/renderer/model/panel-layout.js');
  assert.equal(panelSplit(301, 301, 1000), 0);
  assert.equal(panelSplit(100, 301, 1000), 0);
  assert.equal(panelSplit(501, 301, 1000), 0.2);
  assert.equal(panelSplit(801, 301, 1000), 0.5);
  assert.equal(panelSplit(1500, 301, 1000), 0.7);
});

test('narrow windows remain bounded and header/body share collapsible tracks', async () => {
  const { panelSplit, panelColumns } = await import('../src/renderer/model/panel-layout.js');
  for (const width of [0, 200, 500, 2000]) {
    assert.equal(panelSplit(0, 0, width), 0);
    const split = panelSplit(5000, 0, width);
    assert.ok(Number.isFinite(split) && split >= 0 && split < 1);
  }
  assert.equal(panelColumns(300, 0), '300px 1px minmax(0, 0fr) 1px minmax(0, 1fr)');
  assert.equal(panelColumns(300, 0.5), '300px 1px minmax(0, 0.5fr) 1px minmax(0, 0.5fr)');
});

test('sidebar resizing keeps the right pane fixed, but the preview can still cover the document', async () => {
  const { workspacePanels } = await import('../src/renderer/model/panel-layout.js');
  const initial = workspacePanels(1440, 300);
  assert.equal(initial.right, 660);
  const moved = workspacePanels(1440, 400, initial.right);
  assert.equal(moved.right, initial.right);
  assert.equal(moved.documentWidth, initial.documentWidth - 100);
  const full = workspacePanels(1440, 300, 2000);
  assert.equal(full.documentWidth, 0);
  assert.equal(full.right, 1138);
  assert.equal(full.columns, '300px 1px minmax(0, 1fr) 1px 1138px');
  assert.ok(workspacePanels(1440, 300, 700).documentWidth > 0, 'the divider can uncover the editor again');
  for (const width of [320, 600, 1000, 1800]) {
    const parts = workspacePanels(width, 520, 1500);
    assert.ok(parts.documentWidth >= 0 && parts.right >= 0);
    assert.equal(parts.rail + parts.right + parts.documentWidth + 2, width);
  }
});

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

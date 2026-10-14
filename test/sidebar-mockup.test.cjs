const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the standalone mockup's navigation without a browser or the Electron app.
function preview(height = 1000) {
  const html = fs.readFileSync(path.join(__dirname, '../design/sidebar-mockup/Sidebar.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = {}, elements = new Map(), timers = new Map();
  let timerId = 0;
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', dataset: {}, querySelector: () => null,
      getBoundingClientRect: () => ({ left: 8, right: 288, top: 80, bottom: 110, width: 280 }),
      focus() {}, scrollIntoView() {},
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    console, Date, Set, Map,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval() {},
    window: { innerHeight: height, innerWidth: 1400, addEventListener() {} },
    document: {
      activeElement: null,
      querySelector: (selector) => /^(#|\.stage-body)/.test(selector) ? element(selector) : null,
      querySelectorAll: () => [],
      addEventListener: (kind, fn) => (listeners[kind] ||= []).push(fn),
    },
  });
  vm.runInContext(source, context);
  const read = (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
  const run = (code) => vm.runInContext(code, context);
  const key = (key, modifiers = {}) => {
    const event = {
      key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
      target: { dataset: {}, matches: () => false },
      preventDefault() { this.prevented = true; }, stopPropagation() {}, ...modifiers,
    };
    for (const fn of listeners.keydown || []) fn(event);
    return event;
  };
  const click = (act, id) => {
    const target = { dataset: { act, id }, closest: () => target };
    for (const fn of listeners.click || []) fn({ target, stopPropagation() {} });
  };
  const dispatch = (kind, event = {}) => (listeners[kind] || []).forEach(fn => fn(event));
  const flushTimers = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
  return { read, run, key, click, elements, dispatch, flushTimers };
}

test('project section has at most three root children and ten rows including descendants and More', () => {
  for (const height of [700, 1000, 1800]) {
    const p = preview(height);
    for (const target of [
      'engelbart/user-interface/sidebar',
      'engelbart/agents/bart-build-agents/sandbox',
      'engelbart/onboarding',
    ]) {
      p.run(`goProject(${JSON.stringify(target)})`);
      const section = p.read('projectsSection()');
      assert.ok((section.match(/class="row(?: [^"]*)?"/g) || []).length <= 10, `row cap at ${height}px`);
      assert.ok(p.read('[...PLAN.shown].filter(id => N[id].level === 2).length') <= 3);
      assert.ok(p.read('pathIds(scope()).some(id => PLAN.shown.has(id))'), 'current branch remains visible');
    }
  }
});

test('opening a visible project keeps the section order stable', () => {
  const p = preview();
  const order = p.read('PLAN.order');
  const target = order[order.length - 1];
  p.run(`goProject(${JSON.stringify(target)})`);
  assert.deepEqual(p.read('PLAN.order'), order);
});

test('selecting level-three and level-four projects never displaces their earlier siblings', () => {
  const p = preview();
  p.run('goProject("engelbart/user-interface")');
  const siblings = p.read('PLAN.visible.filter(id => N[id].level === 3)');
  for (const id of ['engelbart/user-interface/sidebar', 'engelbart/user-interface/sidebar/notifications']) {
    p.click('open-project', id);
    assert.deepEqual(p.read('PLAN.visible.filter(id => N[id].level === 3)'), siblings);
    assert.equal(p.read('page().id'), id);
  }
});

test('expansion follows one branch, including when switching between distant projects', () => {
  const p = preview();
  for (const target of ['engelbart/agents', 'engelbart/onboarding', 'engelbart/user-interface/sidebar']) {
    p.run(`goProject(${JSON.stringify(target)})`);
    for (const level of [2, 3, 4]) {
      assert.ok(p.read(`[...S.expanded].filter(id => N[id].level === ${level}).length`) <= 1);
    }
  }
});

test('Ctrl+1 selects the first second-level project and consumes the key', () => {
  const p = preview();
  const first = p.read('N[S.top].children[0]');
  const event = p.key('1', { ctrlKey: true });
  assert.equal(p.read('page().id'), first);
  assert.equal(event.prevented, true);
});

test('Cmd+J opens the waiting agent itself before finished work, then skips the selected agent', () => {
  const p = preview();
  const waiting = p.read('AGENTS.find(a => a.state === "needs")');
  const event = p.key('j', { metaKey: true });
  assert.equal(event.prevented, true);
  assert.equal(p.read('page().id'), waiting.node);
  assert.ok(p.elements.get('.stage-body').innerHTML.includes(waiting.title));
  p.key('j', { metaKey: true });
  assert.notEqual(p.read('page().id'), waiting.node);
});

test('clicking an agent opens its project and agent content without promoting its branch', () => {
  const p = preview();
  const order = p.read('PLAN.order');
  const agent = p.read('AGENTS.find(a => a.id === "a4")');
  p.click('go-agent', agent.id);
  assert.equal(p.read('page().id'), agent.node);
  assert.ok(p.elements.get('.stage-body').innerHTML.includes(agent.title));
  assert.deepEqual(p.read('PLAN.order'), order);
});

test('one status pill counts active agents, caps its display, and stops pulsing after the last run', () => {
  const p = preview();
  assert.deepEqual(p.read('agentSummary()'), { total: 4, ready: 3, running: 1 });
  assert.match(p.read('mark(agentSummary())'), /status-pill running/);
  p.run('AGENTS.find(a => a.state === "running").state = "unseen"');
  assert.deepEqual(p.read('agentSummary()'), { total: 4, ready: 4, running: 0 });
  assert.match(p.read('mark(agentSummary())'), /status-pill ready/);
  p.run('for(let i=0;i<12;i++) AGENTS.push({id:"extra"+i,node:scope(),state:"unseen"})');
  assert.match(p.read('mark(agentSummary())'), />9\+<\/span>/);
  p.run('AGENTS.forEach(a => a.state="done")');
  assert.equal(p.read('mark(agentSummary())'), '');
});

test('roll-up pill counts each agent once even when given overlapping ancestors', () => {
  const p = preview();
  assert.deepEqual(p.read('agentSummary(["engelbart/user-interface", "engelbart/user-interface/sidebar"], true)'), { total: 2, ready: 1, running: 1 });
});

test('the project guide follows the deepest open branch instead of the selected project parent', () => {
  const p = preview();
  // A smaller sibling group leaves room for the deepest group's children.
  p.run('N["engelbart/user-interface"].children = ["engelbart/user-interface/middle-canvas", "engelbart/user-interface/sidebar"]; render()');
  assert.equal(p.read('guideParent()'), 'engelbart/user-interface/sidebar');
  p.run('goProject("engelbart/user-interface/sidebar/notifications")');
  assert.equal(p.read('guideParent()'), 'engelbart/user-interface/sidebar');
  p.run('goProject("engelbart/user-interface")');
  assert.equal(p.read('guideParent()'), 'engelbart/user-interface');
});

test('Sources header owns Add sources and the current project folder replaces Notes and Files groups', () => {
  const p = preview();
  const rail = p.elements.get('#rail').innerHTML;
  const fixed = rail.match(/<nav[\s\S]*?<\/nav>/)[0];
  assert.match(fixed, /data-act="search"/);
  assert.doesNotMatch(fixed, /data-act="add"/);
  const sources = p.read('sourcesSection()');
  assert.match(sources, />Sources<span/);
  assert.match(sources, /class="sec-head"[\s\S]*?data-act="add"/);
  assert.match(sources, /data-act="source-toggle" data-id="project"/);
  assert.match(sources, />Sidebar<\/span>/);
  assert.doesNotMatch(sources, />Notes<|>Add sources<|class="notes"/);
  assert.match(sources, /data-act="new-source-folder"[\s\S]*?>Create new</);
  const header = rail.match(/<div class="head">([\s\S]*?)<div class="scroll"/)[1];
  assert.match(header, /data-act="new-note"/);
  assert.doesNotMatch(header, /data-act="search"/);
});

test('Sources starts expanded in empty projects and can still be manually collapsed', () => {
  const p = preview();
  p.run('goProject("engelbart/getting-started")');
  assert.match(p.read('sourcesSection()'), /data-act="sec-sources" data-open="1" aria-expanded="true"/);
  assert.match(p.read('sourcesSection()'), /data-act="new-source-folder"/);
  p.click('sec-sources');
  assert.match(p.read('sourcesSection()'), /data-act="sec-sources" data-open="0" aria-expanded="false"/);
  p.click('sec-sources');
  assert.match(p.read('sourcesSection()'), /data-act="new-source-folder"/);
});

test('source folders collapse independently and expose an add button only when expanded', () => {
  const p = preview();
  assert.match(p.read('sourcesSection()'), /data-act="add" data-folder="project"/);
  assert.doesNotMatch(p.read('sourcesSection()'), /data-act="add" data-folder="refs"/);
  p.click('source-toggle', 'refs');
  assert.match(p.read('sourcesSection()'), /data-act="add" data-folder="refs"/);
  p.click('source-toggle', 'project');
  assert.doesNotMatch(p.read('sourcesSection()'), /data-act="open-item"/);
  assert.match(p.read('sourcesSection()'), /data-act="add" data-folder="refs"/);
});

test('source folder creation and adding a note preserve the folder destination', () => {
  const p = preview();
  p.click('new-source-folder');
  p.run('open.value="Reading"');
  p.click('create-source-folder');
  const id = p.read('S.sharedSourceFolders.find(id => ITEMS[id].name === "Reading")');
  assert.ok(id);
  p.run(`open={kind:"add",folder:${JSON.stringify(id)},value:"https://example.com"}; addLink()`);
  assert.equal(p.read(`ITEMS[${JSON.stringify(id)}].children.length`), 1);
  p.run(`open={kind:"add",folder:${JSON.stringify(id)}}`);
  p.click('new-note');
  assert.equal(p.read(`ITEMS[${JSON.stringify(id)}].children.length`), 2);
  assert.ok(!p.read('SOURCES[scope()].includes(page().id)'));
});

test('shared source folders and their contents and expansion persist across nested and top-level projects', () => {
  const p = preview();
  p.click('source-toggle', 'refs');
  p.run('open={kind:"add",folder:"refs",value:"https://example.com"}; addLink()');
  const child = p.read('ITEMS.refs.children[0]');
  for (const id of ['engelbart/onboarding', 'memex/reading-trails', 'engelbart/user-interface/sidebar']) {
    p.run(`goProject(${JSON.stringify(id)})`);
    const html = p.read('sourcesSection()');
    assert.match(html, /data-act="source-toggle" data-id="refs" aria-expanded="true"/);
    assert.match(html, new RegExp(`data-act="open-item" data-id="${child}"`));
    if (id !== 'engelbart/user-interface/sidebar') assert.doesNotMatch(html, /data-id="copy-button"/);
  }
  p.click('source-toggle', 'refs');
  p.run('goProject("engelbart/onboarding")');
  assert.match(p.read('sourcesSection()'), /data-act="source-toggle" data-id="refs" aria-expanded="false"/);
  p.click('new-source-folder');
  p.run('open.value="Shared reading"');
  p.click('create-source-folder');
  p.run('goProject("fundraising")');
  assert.match(p.read('sourcesSection()'), />Shared reading<\/span>/);
});

test('a level with more than five siblings shows at most four and a More row', () => {
  const p = preview();
  p.run('goProject("engelbart/agents")');
  assert.ok(p.read('N["engelbart/agents"].children.filter(id=>PLAN.shown.has(id)).length') <= 4);
  assert.match(p.read('projectsSection()'), /data-act="siblings" data-id="engelbart\/agents"/);
});

test('number shortcuts stay assigned to second-level projects across expanded descendants and More', () => {
  const p = preview();
  const roots = p.read('N[S.top].children.slice(0,9)');
  for (let i = 0; i < roots.length; i++) {
    p.key(String(i + 1), { ctrlKey: true });
    assert.equal(p.read('page().id'), roots[i]);
    assert.equal(p.read('N[page().id].level'), 2);
  }
  p.run('goProject("engelbart/user-interface/sidebar/notifications")');
  p.key('2', { ctrlKey: true });
  assert.equal(p.read('page().id'), roots[1]);
});

test('project rows keep their icon and omit inline number hints', () => {
  const p = preview();
  const row = p.read('projectRow("engelbart/user-interface")');
  assert.match(row, /class="ic"><svg[\s\S]*?<\/svg><\/span><span class="lb">User Interface<\/span>/);
  assert.doesNotMatch(row, /⌃/);
  assert.doesNotMatch(p.read('projectRow("engelbart/user-interface/sidebar")'), /⌃|Ctrl\+/);
});

test('each top-level project has its own independent number shortcut list', () => {
  const p = preview();
  for (const root of ['engelbart', 'memex', 'fundraising', 'engelbart']) {
    p.run(`goProject(${JSON.stringify(root)})`);
    const children = p.read('N[S.top].children.slice(0,9)');
    for (let i = 0; i < children.length; i++) {
      p.key(String(i + 1), { ctrlKey: true });
      assert.equal(p.read('page().id'), children[i]);
      assert.equal(p.read('N[page().id].top'), root);
    }
  }
});

test('expanded parents and grandparents retain the complete descendant notification count', () => {
  const p = preview();
  const parent = p.read('projectRow("engelbart/user-interface/sidebar")');
  const grandparent = p.read('projectRow("engelbart/user-interface")');
  for (const row of [parent, grandparent]) assert.match(row, /aria-label="1 to view, 1 running">2<\/span>/);
  const picker = p.elements.get('#rail').innerHTML.match(/<button class="picker"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(picker, /project-count|status-pill|to view/);
});

test('each highest-level project in the switcher shows only its own subtree total', () => {
  const p = preview();
  p.run('AGENTS.push({id:"foreign",node:"memex/reading-trails",state:"unseen"}); open={kind:"project",anchor:{left:8,right:120,top:40,bottom:70},sub:{left:8,right:230,top:70,bottom:100}}');
  const menu = p.read('projectMenu()');
  const memex = menu.match(/data-act="switch-top" data-id="memex"[\s\S]*?<\/button>/)[0];
  assert.match(memex, /aria-label="1 to view, 0 running">1<\/span>/);
  const engelbart = menu.match(/data-act="switch-top" data-id="engelbart"[\s\S]*?<\/button>/)[0];
  assert.match(engelbart, /aria-label="3 to view, 1 running">4<\/span>/);
});

test('hover cards include the parent, expand every child, and guide only the deepest group without chevrons', () => {
  const p = preview();
  p.run('hover={kind:"fly",id:"engelbart/user-interface",rect:{left:8,right:280,top:100,bottom:130},folded:new Set(["engelbart/user-interface/sidebar"])}');
  const html = p.read('flyout()');
  assert.match(html, /data-act="open-project" data-id="engelbart\/user-interface"/);
  assert.match(html, /data-id="engelbart\/user-interface\/sidebar\/notifications"/);
  assert.match(html, /data-parent="engelbart\/user-interface\/sidebar" data-guide="1"/);
  assert.match(html, /data-parent="engelbart\/user-interface" data-guide="0"/);
  assert.doesNotMatch(html, /data-act="tree-fold"|class="chev"/);
});

test('More panels retain collapsible tree controls independently of hover cards', () => {
  const p = preview();
  p.run('open={kind:"siblings",id:"engelbart/user-interface",anchor:{left:8,right:280,top:100,bottom:130},folded:new Set()}');
  assert.match(p.read('siblingsPanel()'), /data-act="tree-fold"/);
  p.run('open.folded.add("engelbart/user-interface/sidebar")');
  assert.doesNotMatch(p.read('siblingsPanel()'), /data-id="engelbart\/user-interface\/sidebar\/notifications"/);
});

test('hover cards with only direct children omit the vertical guide', () => {
  const p = preview();
  for (const id of ['engelbart/onboarding', 'engelbart/user-interface/sidebar']) {
    p.run(`hover={kind:"fly",id:${JSON.stringify(id)},rect:{left:8,right:280,top:100,bottom:130}}`);
    const html = p.read('flyout()');
    assert.match(html, /class="fly-kids"/);
    assert.doesNotMatch(html, /data-guide="1"/);
  }
});

test('Library quick filters narrow results and combine with search', () => {
  const p = preview();
  p.run('open={kind:"library",q:"",anchor:{left:8,right:280,top:100,bottom:130}}');
  assert.match(p.read('libraryPanel()'), /aria-label="Show only"/);
  for (const [filter, present, absent] of [
    ['notes', 'copy-button', 'nav-board'],
    ['papers', 'nav-board', 'copy-button'],
    ['repos', 'berkeley', 'nav-board'],
    ['web', 'mockup', 'copy-button'],
    ['files', 'refs', 'mockup'],
  ]) {
    p.click('library-filter', filter);
    const html = p.read('libraryPanel()');
    assert.match(html, new RegExp(`data-id="${present}"`));
    assert.doesNotMatch(html, new RegExp(`data-act="open-item" data-id="${absent}"`));
    assert.match(html, new RegExp(`data-act="library-filter" data-id="${filter}" aria-pressed="true"`));
  }
  p.click('library-filter', 'notes');
  p.run('open.q="Canvas"');
  assert.match(p.read('libraryPanel()'), /data-act="open-item" data-id="canvas-focus"/);
  assert.doesNotMatch(p.read('libraryPanel()'), /data-act="open-item" data-id="copy-button"/);
  p.click('library-filter', 'papers');
  assert.match(p.read('libraryPanel()'), /Nothing matches/);
  p.click('library-filter', 'all');
  assert.match(p.read('libraryPanel()'), /data-act="open-item" data-id="canvas-focus"/);
});

test('Library item count stays global and shows 999+ only above 999', () => {
  const p = preview();
  for (const [total, label] of [[0, '0'], [998, '998'], [999, '999'], [1000, '999+']]) {
    p.run(`ITEMS={}; SOURCES={}; S.sharedSourceFolders=[]; for(let i=0;i<${total};i++) ITEMS['count-'+i]={id:'count-'+i,name:'Count '+i,kind:'note'}; ITEMS.picture={id:'picture',name:'Attachment',kind:'image'}; open={kind:'library',q:'no matches',filter:'papers',anchor:{left:8,right:280,top:100,bottom:130}}; renderRail()`);
    const row = p.elements.get('#rail').innerHTML.match(/<div class="row" data-act="library"[\s\S]*?<\/div>/)[0];
    assert.ok(row.includes(`class="library-count">${label}</span>`));
    assert.ok(p.read('libraryPanel()').includes(`<b>Library</b><i>${label}</i>`));
  }
});

test('add-source picker searches library items and limits the quick list to five', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}');
  let html = p.read('addPanel()');
  assert.match(html, /placeholder="Search library"/);
  assert.equal((html.match(/data-act="pick-source"/g) || []).length, 5);
  assert.match(html, /data-act="picker-more"/);
  assert.ok(html.indexOf('data-act="picker-more"') < html.indexOf('data-act="show-upload"'));
  assert.ok(html.indexOf('Upload URL or path') < html.indexOf('Add from GitHub'));
  assert.ok(html.indexOf('Add from GitHub') < html.indexOf('New note'));
  assert.doesNotMatch(html, />Sticky<|>Choose from disk/);
  p.run('open.q="Canvas"');
  html = p.read('addPanel()');
  assert.match(html, /data-act="pick-source" data-id="canvas-focus"/);
  assert.doesNotMatch(html, /data-act="pick-source" data-id="copy-button"/);
});

test('the picker Library opens beside the picker and adds results to the selected folder', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}; showPickerLibrary({left:296,right:616,top:94,bottom:420})');
  assert.equal(p.read('open.kind'), 'add');
  const html = p.read('libraryPanel(open.library, true)');
  assert.ok(Number(html.match(/left:(\d+)px/)[1]) > 616, 'Library starts to the right of the picker');
  assert.match(html, /data-act="pick-source"/);
  p.click('pick-source', 'canvas-focus');
  assert.ok(p.read('ITEMS.refs.children.includes("canvas-focus")'));
  assert.ok(!p.read('SOURCES[scope()].includes("canvas-focus")'));
  assert.equal(p.read('open'), null);
});

test('upload and new-note actions in the picker retain their destination', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}');
  assert.doesNotMatch(p.read('addPanel()'), /data-input="add-value"/);
  p.click('show-upload');
  assert.match(p.read('addPanel()'), /data-input="add-value"/);
  p.run('open.value="https://example.com/from-picker"');
  p.click('add-link');
  assert.equal(p.read('ITEMS.refs.children.length'), 1);
  p.run('open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}');
  p.click('new-note');
  assert.ok(p.read('ITEMS.refs.children.includes(page().id)'));
});

test('side Library filters and search work independently and Escape returns to the picker', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",q:"Canvas",anchor:{left:8,right:280,top:100,bottom:130}}; showPickerLibrary({left:296,right:616,top:94,bottom:420})');
  p.click('picker-library-filter', 'papers');
  assert.match(p.read('libraryPanel(open.library, true)'), /Nothing matches/);
  p.dispatch('input', { target: { dataset: { input: 'picker-library-q' }, value: 'Recursive' } });
  assert.match(p.read('libraryPanel(open.library, true)'), /data-act="pick-source" data-id="nav-board"/);
  assert.equal(p.read('open.q'), 'Canvas');
  p.key('Escape');
  assert.equal(p.read('open.kind'), 'add');
  assert.equal(p.read('open.library'), null);
  assert.equal(p.read('open.folder'), 'refs');
});

test('source picker excludes existing contents and prevents folder cycles', () => {
  const p = preview();
  p.run('ITEMS.refs.children=["copy-button"]; ITEMS.outer={id:"outer",name:"Outer",kind:"folder",children:["refs"]}; open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}');
  const html = p.read('addPanel()');
  assert.doesNotMatch(html, /data-act="pick-source" data-id="(?:refs|outer|copy-button)"/);
  p.click('pick-source', 'outer');
  assert.deepEqual(p.read('ITEMS.refs.children'), ['copy-button']);
});

test('hovering between source previews never replaces the open picker DOM', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",q:"",anchor:{left:8,right:280,top:100,bottom:130}}; renderLayer()');
  const layer = p.elements.get('#layer');
  let html = layer.innerHTML, replacements = 0;
  Object.defineProperty(layer, 'innerHTML', {
    get: () => html,
    set: value => { html = value; replacements++; },
  });
  for (const [id, name] of [['copy-button', 'Copy button'], ['mc-overview', 'Middle Canvas']]) {
    const row = {
      dataset: { peek: id }, isConnected: true,
      getBoundingClientRect: () => ({ left: 304, right: 608, top: 140, bottom: 172 }),
      closest: selector => selector === '[data-peek]' ? row : null,
    };
    p.dispatch('mouseover', { target: row });
    p.flushTimers();
    assert.equal(replacements, 0, 'the existing picker must remain mounted');
    assert.match(p.elements.get('#hover-layer').innerHTML, new RegExp(name));
  }
  p.dispatch('mouseleave');
  assert.equal(replacements, 0);
  assert.equal(p.elements.get('#hover-layer').innerHTML, '');
});

test('add-context popup auto-hides after leaving its area without a click', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",anchor:{left:260,right:282,top:100,bottom:122}}; renderLayer(); document.querySelectorAll=selector=>selector.includes("[data-add-picker]")?[{getBoundingClientRect:()=>({left:298,right:618,top:94,bottom:420})}]:[]');
  p.dispatch('mousemove', { clientX: 1100, clientY: 800 });
  assert.equal(p.read('open.kind'), 'add', 'closing waits briefly for gap crossing');
  p.flushTimers();
  assert.equal(p.read('open'), null);
  assert.equal(p.elements.get('#layer').innerHTML, '');
});

test('returning to the trigger, picker, side Library, or preview cancels add-context dismissal', () => {
  const p = preview();
  p.run('open={kind:"add",folder:"refs",anchor:{left:260,right:282,top:100,bottom:122}}; renderLayer(); document.querySelectorAll=selector=>selector.includes("[data-add-picker]")?[{left:298,right:618,top:94,bottom:420},{left:626,right:986,top:88,bottom:600},{left:994,right:1334,top:110,bottom:370}].map(rect=>({getBoundingClientRect:()=>rect})):[]');
  for (const [x, y] of [[270,110], [290,110], [400,200], [622,200], [800,200], [1100,200]]) {
    p.dispatch('mousemove', { clientX: 1100, clientY: 800 });
    p.dispatch('mousemove', { clientX: x, clientY: y });
    p.flushTimers();
    assert.equal(p.read('open.kind'), 'add');
  }
  p.dispatch('mouseleave');
  p.flushTimers();
  assert.equal(p.read('open'), null);
});

test('cursor dismissal is limited to add-context popups', () => {
  const p = preview();
  p.run('open={kind:"library",q:"",anchor:{left:8,right:280,top:100,bottom:130}}; renderLayer()');
  p.dispatch('mousemove', { clientX: 1100, clientY: 800 });
  p.flushTimers();
  assert.equal(p.read('open.kind'), 'library');
});

test('second-level project tooltip shows its actual shortcut after a delay and clears on leaving', () => {
  const p = preview();
  const row = {
    dataset: { shortcutProject: 'engelbart/user-interface', hoverProject: '' }, isConnected: true,
    getBoundingClientRect: () => ({ left: 8, right: 280, top: 100, bottom: 130 }),
    closest: (selector) => selector === '#rail [data-shortcut-project]' || selector === '#rail [data-hover-project]' ? row : null,
  };
  p.dispatch('mouseover', { target: row });
  assert.equal(p.read('shortcutTip'), null);
  p.flushTimers();
  const html = p.elements.get('#tooltip-layer').innerHTML;
  assert.match(html, /role="tooltip"/);
  assert.match(html, /⌃2/);
  assert.match(html, /Toggle project with <kbd>Ctrl \+ 2<\/kbd>/);
  p.dispatch('mouseleave');
  assert.doesNotMatch(p.elements.get('#tooltip-layer').innerHTML, /role="tooltip"/);
});

test('numbered rows suppress the browser title tooltip and deeper rows get no shortcut tooltip', () => {
  const p = preview();
  const row = p.read('projectRow("engelbart/user-interface")').match(/^<div[^>]+>/)[0];
  assert.match(row, /data-shortcut-project="engelbart\/user-interface"/);
  assert.doesNotMatch(row, /\stitle=/);
  p.run('shortcutTip={id:"engelbart/user-interface/sidebar",rect:{left:8,right:280,top:100,bottom:130}}');
  assert.equal(p.read('projectShortcutTip()'), '');
});

test('project plus uses the shared native tooltip with the exact parent name', () => {
  const p = preview();
  const button = {
    dataset: { createTooltip: 'engelbart/agents' }, isConnected: true,
    getBoundingClientRect: () => ({ left: 210, right: 232, top: 100, bottom: 122 }),
    closest: selector => selector === '[data-create-tooltip]' || selector === '.chev, .act' ? button : null,
  };
  p.dispatch('mouseover', { target: button });
  p.flushTimers();
  const html = p.elements.get('#tooltip-layer').innerHTML;
  assert.match(html, /role="tooltip"/);
  assert.match(html, /Create project within Agents/);
  assert.doesNotMatch(html, /Toggle project|⌃/);
  const markup = p.read('projectRow("engelbart/agents")');
  assert.match(markup, /data-create-tooltip="engelbart\/agents"/);
  assert.doesNotMatch(markup, /title="Create project within Agents"/);
});

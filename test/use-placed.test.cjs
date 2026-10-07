'use strict';

// The @ menu keeps where it was scrolled to (MATH-55, src/renderer/ui/usePlaced.js). usePlaced measures the panel after
// every render with its height limit off, and a list that cannot scroll goes back to its top; a hover re-renders the
// menu (MentionMenu.jsx onHover), so without putting the scroll back every hover sent the list to the top.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// usePlaced with a few lines that do what React's hooks do: state, a ref, and the layout effect run after each render.
function hooks() {
  const slots = [];
  let at = 0, dirty = false, effects = [];
  const fake = {
    useRef(init) { const k = at++; if (!slots[k]) slots[k] = { current: init }; return slots[k]; },
    useState(init) {
      const k = at++;
      if (!slots[k]) {
        const slot = { value: init };
        slot.set = (next) => { const v = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(v, slot.value)) { slot.value = v; dirty = true; } };
        slots[k] = slot;
      }
      return [slots[k].value, slots[k].set];
    },
    useLayoutEffect(fn) { at++; effects.push(fn); },
  };
  fake.default = fake;
  // One render as the menu's would be: the hook, its style onto the element, then the effect; again while it set state.
  const render = (hook, el) => {
    for (let n = 0; n < 10; n += 1) {
      at = 0; effects = []; dirty = false;
      const [ref, style] = hook();
      ref.current = el;
      el.style.maxHeight = style.maxHeight != null ? `${style.maxHeight}px` : '';
      for (const go of effects) go();
      if (!dirty) return style;
    }
    throw new Error('rendered 10 times in a row');
  };
  return { fake, render };
}

function load(fake) {
  const filename = path.join(__dirname, '__use-placed.cjs');
  const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/ui/usePlaced.js')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = function (id) { return id === 'react' ? fake : Module.prototype.require.call(this, id); };
  compiled._compile(built.outputFiles[0].text, filename);
  return compiled.exports.usePlaced;
}

// A 1000px list in a panel: with a limit it scrolls, and like a browser's it is put back to its top when the limit goes.
function list(natural = 1000) {
  let maxHeight = '', scrollTop = 0;
  const limit = () => (/^\d+px$/.test(maxHeight) ? parseInt(maxHeight, 10) : Infinity);
  const room = () => Math.max(0, natural - Math.min(natural, limit()));
  return {
    style: {
      get maxHeight() { return maxHeight; },
      set maxHeight(value) { maxHeight = value; scrollTop = Math.min(scrollTop, room()); },
    },
    get offsetHeight() { return Math.min(natural, limit()); },
    offsetWidth: 400,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, room())); },
  };
}

test('the @ menu keeps its scroll through a hover\'s re-render and the document loading (MATH-55)', () => {
  const previous = global.window;
  global.window = { innerWidth: 1200, innerHeight: 800 };
  try {
    const { fake, render } = hooks();
    const usePlaced = load(fake);
    const anchor = { left: 100, right: 100, top: 40, bottom: 60 };
    const el = list();
    const hook = () => usePlaced(anchor, { cap: 420 });
    const first = render(hook, el);
    assert.equal(first.maxHeight, 420, 'the list is cut at the cap and scrolls');
    el.scrollTop = 300; // scrolled down by hand
    assert.equal(el.scrollTop, 300);
    render(hook, el); // a row hovered: the menu renders again and is measured again
    assert.equal(el.scrollTop, 300, 'a hover leaves the list where it was');
    render(hook, el); render(hook, el); // the document loading under it
    assert.equal(el.scrollTop, 300, 'and so does any other render');
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
});

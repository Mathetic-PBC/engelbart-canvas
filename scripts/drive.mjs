#!/usr/bin/env node
// Drive the running app over the Chrome DevTools Protocol for exploratory testing.
//
//   npm run start:debug                      # electron with --remote-debugging-port=9222
//   node scripts/drive.mjs shot out.png      # screenshot (half scale)
//   node scripts/drive.mjs eval "document.title"
//   node scripts/drive.mjs click 100 200 -- wait 300 -- shot after.png
//   node scripts/drive.mjs clicksel "button[title='All projects']"
//   node scripts/drive.mjs type "hello" -- key Enter
//
// Commands: shot <file> | eval <js> | click <x> <y> | clicksel <css> [nth] | drag <x1> <y1> <x2> <y2> | press <x> <y> | moveto <x> <y> [steps] | release <x> <y> | wheel <x> <y> <dx> <dy> [cmd|ctrl] | type <text> | typeslow <text> | key <Key> | wait <ms> | reload [ms] | errors | text
// Several commands run in sequence when separated by `--`.

import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.ENGELBART_DEBUG_PORT || 9222);

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith('engelbart://')) || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target; is the app running with --remote-debugging-port?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
};

function parseKey(spec) {
  // "cmd+1", "shift+Enter", "Escape", "a"
  const parts = spec.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'alt' || p === 'option') modifiers |= 1;
    if (p === 'ctrl' || p === 'control') modifiers |= 2;
    if (p === 'cmd' || p === 'meta' || p === 'command') modifiers |= 4;
    if (p === 'shift') modifiers |= 8;
  }
  const known = KEYS[name];
  if (known) return { ...known, modifiers };
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return { key: name, code: /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : name, keyCode: upper.charCodeAt(0), text: modifiers & 6 ? undefined : name, modifiers };
  }
  return { key: name, code: name, keyCode: 0, modifiers };
}

async function run(commands) {
  const cdp = await connect();
  const out = [];
  let held = null; // where the mouse button went down (press … release)
  try {
    await cdp.send('Runtime.enable');
    for (const command of commands) {
      const [name, ...args] = command;
      if (name === 'wait') await new Promise((resolve) => setTimeout(resolve, Number(args[0] || 300)));
      else if (name === 'shot') {
        const { width, height } = (await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({width:innerWidth,height:innerHeight})', returnByValue: true })).result.value ? JSON.parse((await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({width:innerWidth,height:innerHeight})', returnByValue: true })).result.value) : { width: 1440, height: 900 };
        const scale = Number(args[1] || 0.5);
        const result = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale } });
        writeFileSync(args[0], Buffer.from(result.data, 'base64'));
        out.push(`shot ${args[0]} (${width}x${height} @${scale})`);
      } else if (name === 'eval') {
        const result = await cdp.send('Runtime.evaluate', { expression: args.join(' '), awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) out.push(`eval error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
        else out.push(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value));
      } else if (name === 'click' || name === 'clicksel') {
        let x;
        let y;
        if (name === 'click') {
          x = Number(args[0]);
          y = Number(args[1]);
        } else {
          const nth = Number(args[1] || 0);
          const expression = `(() => { const els = document.querySelectorAll(${JSON.stringify(args[0])}); const el = els[${nth}]; if (!el) return null; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2}); })()`;
          const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
          if (!result.result.value) throw new Error(`clicksel: no element for ${args[0]}`);
          ({ x, y } = JSON.parse(result.result.value));
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        out.push(`click ${Math.round(x)},${Math.round(y)}`);
      } else if (name === 'drag') {
        const [x1, y1, x2, y2] = args.map(Number);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
        const steps = 8;
        for (let i = 1; i <= steps; i += 1) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, button: 'left', buttons: 1 });
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
        out.push(`drag ${x1},${y1} → ${x2},${y2}`);
      } else if (name === 'press' || name === 'moveto' || name === 'release') {
        // A drag in pieces, so its middle can be looked at: press <x> <y> -- moveto <x> <y> [steps] -- shot … -- release <x> <y>
        const [x, y] = args.map(Number);
        if (name === 'press') {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
          held = { x, y };
        } else if (name === 'moveto') {
          const from = held || { x, y };
          const steps = Number(args[2] || 12);
          for (let i = 1; i <= steps; i += 1) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps, button: 'left', buttons: 1 });
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          held = { x, y };
        } else {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          held = null;
        }
        out.push(`${name} ${x},${y}`);
      } else if (name === 'wheel') {
        const [x, y, dx, dy] = args.map(Number);
        const modifiers = args[4] ? parseKey(`${args[4]}+x`).modifiers : 0;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx || 0, deltaY: dy || 0, modifiers });
        out.push(`wheel ${dx},${dy} at ${x},${y}`);
      } else if (name === 'typeslow') {
        // One character per input event with a pause, so the app re-renders between keystrokes as it does for a person.
        for (const ch of args.join(' ')) { await cdp.send('Input.insertText', { text: ch }); await new Promise((resolve) => setTimeout(resolve, 45)); }
        console.log(`typed ${args.join(' ').length} chars, one at a time`);
      } else if (name === 'type') {
        await cdp.send('Input.insertText', { text: args.join(' ') });
        out.push(`typed ${args.join(' ').length} chars`);
      } else if (name === 'key') {
        const spec = parseKey(args[0]);
        const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: spec.modifiers };
        await cdp.send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', ...base, text: spec.text, unmodifiedText: spec.text });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        out.push(`key ${args[0]}`);
      } else if (name === 'reload') {
        await cdp.send('Page.enable');
        await cdp.send('Page.reload', { ignoreCache: true });
        await new Promise((resolve) => setTimeout(resolve, Number(args[0] || 1500)));
        out.push('reloaded');
      } else if (name === 'errors') {
        const result = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__errors || [], null, 1)', returnByValue: true });
        out.push(result.result.value);
      } else if (name === 'text') {
        const result = await cdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
        out.push(result.result.value);
      } else throw new Error(`Unknown command: ${name}`);
    }
  } finally {
    cdp.close();
  }
  return out;
}

const commands = [];
let current = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--') {
    if (current.length) commands.push(current);
    current = [];
  } else current.push(arg);
}
if (current.length) commands.push(current);
if (!commands.length) {
  console.log('usage: node scripts/drive.mjs <command> [args] [-- <command> ...]');
  process.exit(1);
}
run(commands).then((lines) => {
  for (const line of lines) console.log(line);
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

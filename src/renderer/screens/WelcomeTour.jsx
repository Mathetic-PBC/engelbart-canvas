import React from 'react';
import Button from '../ui/Button.jsx';

// The welcome tour (2026-09-29): port of Claude Design "Welcome Tour v2.dc.html" (project c321ac1f…, chat "Welcome
// animation design"; Hudson's tweaks in design/welcome-tour/TWEAKS.md). A new install sees it right after onboarding's
// "Open project", and Engelbart ▸ Welcome Tour shows it again. It is a scripted Getting started screen, not the live
// workspace: nothing it does reaches the library, the documents or an agent. Leaving it (Done on the last step, or
// Escape) opens the real project (App.jsx).
//
// Kept from the design as it is: the text, the steps, the hand, the ring and the dimming, the timings. Changed for the
// window: the header rows drag it and the crumb clears the traffic lights (the design's crumb was the old "Engelbart /
// <project> / Getting started" with the ellipses written in; here the project is the person's and the ellipses are
// the browser's); the root fills the window instead of a 680px minimum (the window can be 560 tall); the test pill is
// the app's own (WindowControls); closing opens the project instead of showing "Replay tour ›".

const SANS = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const EASE = 'cubic-bezier(.25,.1,.25,1)';
const RISE = `rise 260ms ${EASE}`;

// The design's own <style> block, scoped. The app's global rules differ in three places the design never had: every
// box is border-box, placeholders are italic, and buttons draw a focus ring.
const TOUR_CSS = `
[data-welcome-tour],[data-welcome-tour] *{box-sizing:revert}
[data-welcome-tour] input::placeholder{color:#8f8f8f;font-style:normal}
[data-welcome-tour] button:focus-visible{box-shadow:none}
@keyframes tour-thinking{0%,100%{opacity:.25}50%{opacity:1}}
`;

const WS_ICON = 'M2.5 1.5h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M9 1.5h4.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M2.5 8h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z';
const NOTE_ICON = 'M4.5 1.5h4.5L12 4.5v9a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z M9 1.5v3h3 M5.75 8h4.5 M5.75 10.5h4.5';
const GLOBE_ICON = 'M2 8h12 M8 2c-2.2 2.4-2.2 9.6 0 12 M8 2c2.2 2.4 2.2 9.6 0 12';

function SearchGlass({ size }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>;
}

function WsGlyph({ size, stroke = '#171717', width = 1.3 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke, strokeWidth: width, strokeLinejoin: 'round' }}><path d={WS_ICON} /></svg>;
}

function Globe({ size, stroke = '#171717' }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke, strokeWidth: 1.3 }}><circle cx="8" cy="8" r="6" /><path d={GLOBE_ICON} /></svg>;
}

/** The design system's MicroLabel, size sm, tone faint. */
function MicroLabel({ children }) {
  return <div><div style={{ font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: 'var(--fnt)' }}>{children}</div></div>;
}

const sectionLabel = { padding: '10px 10px 4px', fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, color: '#8f8f8f' };
const menuRow = { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', transition: 'background 120ms' };
const wsRow = { padding: '8px 10px', borderRadius: 6, cursor: 'pointer', transition: 'background 120ms' };
const footWord = { padding: '3px 6px', border: 0, borderRadius: 5, background: '#ffffff', cursor: 'pointer', font: `400 15px/1.4 ${SANS}`, transition: 'color 120ms' };
const smallAct = { padding: '4px 2px', border: 0, background: 'transparent', color: '#8f8f8f', font: `500 12px/1.4 ${SANS}`, cursor: 'pointer' };
const answerIcon = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: 'none', cursor: 'pointer', color: '#4d4d4d' };
const stageTab = { width: 170, minWidth: 0, height: 30, boxSizing: 'border-box', padding: '0 10px', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#4d4d4d' };

function Chevron() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d="m5 8.5 7 7 7-7" /></svg>;
}

function UpArrow() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>;
}

function SendArrow() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="square" aria-hidden="true"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4" /></svg>;
}

/** The "Opus High ⌄" model word in the pills. */
function ModelWord() {
  return (
    <>Opus High<span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 10, height: 12, font: `12px/1 ${SANS}`, color: '#8f8f8f' }}><span style={{ position: 'relative', top: -3 }}>⌄</span></span></>
  );
}

export default class WelcomeTour extends React.Component {
  // The tour. target: data-tour keys to ring (unioned); point: where the hand rests; need: when it's done; auto: advance
  // by itself; after: the text once it's done.
  steps = [
    { title: 'Welcome to Engelbart', body: 'Take a look at some of Engelbart\'s features so you know how best to use it. Each step asks you to do one thing.' },
    { target: ['wsBox'], title: 'This is a workspace', body: 'A workspace holds all of your websites, papers, notes, and code so that you can quickly bring all of your context together when building a new project.' },
    { target: ['wsBox', 'wsMenu'], point: 'wsBox', title: 'Switch workspaces', body: 'Every workspace you have is one hover away.', task: 'Hover over Getting started', need: (s) => s.wsSeen, after: 'Every workspace you have is listed here. Click one to move to it; search finds the rest.' },
    { target: ['wsNew'], point: 'wsNew', title: 'Start a new one', body: 'New workspaces start from the bottom of the same list.', task: 'Hover over + New', need: (s) => s.newSeen, after: '+ New makes a workspace with an empty document and nothing in its sidebar yet.', keepWs: true },
    { target: ['addRow'], point: 'addRow', title: 'Add context', body: 'Context is what you and the agent can read: notes, websites, GitHub repos and files.', task: 'Hover over Add context', need: (s) => s.addSeen, auto: true },
    { target: ['addMenu'], point: 'urlField', title: 'Add a website', body: 'Click Upload URL or path. Websites, papers, repos and files all come in here.', task: 'Paste https://mathetic.com', need: (s) => s.added, auto: true, keepAdd: true },
    { target: ['siteRow'], point: 'siteRow', title: 'Open it in the Stage', body: 'It\'s under Websites now. Everything in the sidebar opens beside your note.', task: 'Click mathetic.com', need: (s) => s.stageOpen, auto: true },
    { target: ['stage'], title: 'The Stage', body: 'Websites, papers and files open here, so you can read next to what you\'re writing. Terminal sits in the tab beside it.' },
    { target: ['noteBody'], title: 'This is a note', body: 'Notes are plain markdown files in your project folder. Write anything here; the agent reads them as context.', tab: 'note' },
    { target: ['bartArea'], point: 'bartLine', title: 'Ask @bart', body: 'Type @bart and a question on any line. Bart reads the note and what you\'ve added.', task: 'Ask what mathetic.com is about', need: (s) => s.answer === 'done', after: 'The answer lands under the question. Respond at the bottom of the card to follow up.', tab: 'note' },
    { target: (s) => (s.tab === 'workspace' ? ['wsDoc', 'buildBtn'] : ['wsTab']), point: (s) => (s.tab === 'workspace' ? 'buildBtn' : 'wsTab'), title: 'What Build does', body: 'Build hands this document to a coding agent. It works in a repository in your project folder, with a history of its own.', need: (s) => s.buildOpen, auto: true },
    { target: ['buildPanel'], point: 'send', title: 'Begin coding', body: 'Pick the repository and the model, then press the arrow. The website you added comes along as context.', task: 'Press the blue arrow', need: (s) => s.bStatus !== 'none', auto: true, tab: 'workspace', keepBuild: true },
    { target: ['buildCard'], title: 'You\'re building', body: 'The Build lands in the workspace document as a card. It shows what the agent is doing while it works; reply to it any time.', need: (s) => s.bStatus === 'review' || s.bStatus === 'accepted', after: 'Done. Review shows every change it made; Accept keeps them.', tab: 'workspace' },
    { target: ['buildCard'], point: 'accept', title: 'Accept it', body: 'Accept keeps the agent\'s changes in engelbart/. Discard throws them away.', need: (s) => s.bStatus === 'accepted', after: 'Accepted. The changes are in engelbart/ on main.', tab: 'workspace' },
    { target: (s) => (s.live ? ['stage'] : ['buildCard']), point: 'preview', title: 'See it live', body: 'Every Build gets a live preview of what it made. Open it in the Stage.', need: (s) => s.live, after: 'This is the page the agent built, running in the Stage. Change the plan and Build again to change it.', tab: 'workspace' },
  ];

  state = {
    step: 0, open: this.props.autoStart ?? true, hl: { l: 0, t: 0, w: 0, h: 0 }, card: { l: 0, t: 0 }, pt: { x: 0, y: 0, on: false },
    wsHover: false, wsSeen: false, newHover: false, newSeen: false, addHover: false, addSeen: false, urlFocus: false,
    addUp: false, url: '', added: false, site: 'mathetic.com', stageOpen: false, tab: 'note', q: '', askedQ: '', answer: 'none', buildOpen: false, building: false, askDoing: '', askSteps: 0, bStatus: 'none', bDoing: '', bSteps: 0, bNotes: [], live: false,
  };

  timers = [];

  later = (fn, ms) => { this.timers.push(setTimeout(fn, ms)); };

  rootRef = React.createRef();

  cardRef = React.createRef();

  bartInput = React.createRef();

  componentDidMount() {
    this.onKey = (e) => {
      if (!this.state.open) return;
      const typing = e.target && /INPUT|TEXTAREA/.test(e.target.tagName);
      if (e.key === 'Escape') this.close();
      else if (typing) return;
      else if (e.key === 'ArrowRight' && !this.blocked()) this.next();
      else if (e.key === 'ArrowLeft') this.prev();
    };
    this.onResize = () => this.measure();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.ro = new ResizeObserver(this.onResize);
    [0, 50, 200, 600].forEach((d) => this.later(() => this.measure(), d));
    this.poll = setInterval(() => this.measure(), 150);
    const attach = () => { if (this.rootRef.current) this.ro.observe(this.rootRef.current); else this.attachT = setTimeout(attach, 30); };
    attach();
  }

  // The Add context menu opens under its row, as in the design. In a window too short for it (the design's page had a
  // 680px minimum and scrolled; the app's window can be 560 tall) it opens above, as the app's own menus do
  // (ui/usePlaced.js), or the field the tour points at would be out of reach.
  componentDidUpdate() {
    const root = this.rootRef.current;
    const menu = root && root.querySelector('[data-tour="addMenu"]');
    if (!menu) { if (this.state.addUp) this.setState({ addUp: false }); return; }
    if (this.state.addUp) return;
    const R = root.getBoundingClientRect();
    const row = root.querySelector('[data-tour="addRow"]').getBoundingClientRect();
    if (menu.getBoundingClientRect().bottom > R.bottom - 8 && row.top - R.top - 44 > R.bottom - row.bottom) this.setState({ addUp: true });
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
    clearInterval(this.poll); clearTimeout(this.attachT); clearTimeout(this.autoT); this.timers.forEach(clearTimeout);
  }

  measure() {
    const root = this.rootRef.current;
    if (!root || !this.state.open) return;
    const R = root.getBoundingClientRect();
    if (!R.width) return;
    const s0 = this.steps[this.state.step];
    const res = (v) => (typeof v === 'function' ? v(this.state) : v);
    const s = { ...s0, target: res(s0.target), point: res(s0.point) };
    const rects = [];
    (s.target || []).forEach((k) => root.querySelectorAll(`[data-tour="${k}"]`).forEach((e) => {
      const sc = e.closest('[data-scroller]');
      let r = e.getBoundingClientRect();
      if (sc && s.target[0] === k) {
        // Bring the step's first target into its scroller's view (no scrollIntoView).
        const c = sc.getBoundingClientRect();
        if (r.bottom > c.bottom - 16 && r.top > c.top + 16) sc.scrollTop += Math.min(r.bottom - c.bottom + 24, r.top - c.top - 24);
        else if (r.top < c.top) sc.scrollTop -= c.top - r.top + 24;
        r = e.getBoundingClientRect();
      }
      if (sc) { const c = sc.getBoundingClientRect(); r = { left: r.left, right: r.right, top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom), width: r.width, height: 1 }; if (r.bottom <= r.top) return; }
      if (r.width || r.height) rects.push(r);
    }));
    const CW = 320;
    const CH = (this.cardRef.current && this.cardRef.current.offsetHeight) || 220;
    const pad = 6;
    const gap = 16;
    const m = 12;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    let hl;
    let card;
    if (!rects.length && (s.target || []).length) return;
    if (!rects.length) {
      hl = { l: R.width / 2, t: R.height / 2, w: 0, h: 0 };
      card = { l: (R.width - CW) / 2, t: (R.height - CH) / 2 };
    } else {
      const u = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 });
      const l0 = Math.max(2, u.left - R.left - pad);
      const t0 = Math.max(2, u.top - R.top - pad);
      const r0 = Math.min(R.width - 2, u.right - R.left + pad);
      const b0 = Math.min(R.height - 2, u.bottom - R.top + pad);
      hl = { l: l0, t: t0, w: Math.max(0, r0 - l0), h: Math.max(0, b0 - t0) };
      const ty = cl(hl.t, m, R.height - CH - m);
      if (R.width - (hl.l + hl.w) >= CW + gap + m) card = { l: hl.l + hl.w + gap, t: ty };
      else if (hl.l >= CW + gap + m) card = { l: hl.l - CW - gap, t: ty };
      else if (hl.h > R.height * 0.5) card = { l: R.width - CW - m, t: m + 44 };
      else {
        const below = hl.t + hl.h + gap;
        card = { l: cl(hl.l, m, R.width - CW - m), t: below + CH <= R.height - m ? below : Math.max(m, hl.t - CH - gap) };
      }
    }
    // The pointer: rests on the thing to hover or click until it's been done.
    let pt = { x: this.state.pt.x, y: this.state.pt.y, on: false };
    const pe = s.point && !(s.need && s.need(this.state)) && root.querySelector(`[data-tour="${s.point}"]`);
    if (pe) {
      let r = pe.getBoundingClientRect();
      const sc = pe.closest('[data-scroller]');
      let visible = true;
      if (sc) {
        // The thing to click wins over the target's top: bring it into view, leaving room for the hand below it.
        const c = sc.getBoundingClientRect();
        if (r.bottom > c.bottom - 60) sc.scrollTop += r.bottom - c.bottom + 60;
        else if (r.top < c.top + 16) sc.scrollTop -= c.top - r.top + 16;
        r = pe.getBoundingClientRect();
        const c2 = sc.getBoundingClientRect();
        visible = r.bottom > c2.top && r.top < c2.bottom;
        if (visible) {
          // Re-measure the ring now that the scroller moved.
          const rs = [];
          (s.target || []).forEach((k) => root.querySelectorAll(`[data-tour="${k}"]`).forEach((e) => { const q = e.getBoundingClientRect(); rs.push({ left: q.left, right: q.right, top: Math.max(q.top, c2.top), bottom: Math.min(q.bottom, c2.bottom) }); }));
          if (rs.length) {
            const u = rs.reduce((a, q) => ({ left: Math.min(a.left, q.left), top: Math.min(a.top, q.top), right: Math.max(a.right, q.right), bottom: Math.max(a.bottom, q.bottom) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 });
            hl = { l: Math.max(2, u.left - R.left - pad), t: Math.max(2, u.top - R.top - pad), w: 0, h: 0 };
            hl.w = Math.max(0, Math.min(R.width - 2, u.right - R.left + pad) - hl.l);
            hl.h = Math.max(0, Math.min(R.height - 2, u.bottom - R.top + pad) - hl.t);
          }
        }
      }
      if (visible && (r.width || r.height)) {
        pt = { x: r.left - R.left + Math.min(r.width / 2, 44), y: r.top - R.top + r.height * 0.6, on: true };
        // Never over the thing to click (not in the design, whose window never got small enough for it to happen):
        // the card moves off it and the hand, to the first place that clears both.
        const t = { l: Math.min(r.left - R.left, pt.x - 16), t: Math.min(r.top - R.top, pt.y - 3), r: Math.max(r.right - R.left, pt.x + 24), b: Math.max(r.bottom - R.top, pt.y + 44) };
        const hits = (k) => k.l < t.r && k.l + CW > t.l && k.t < t.b && k.t + CH > t.t;
        const fits = (k) => k.l >= m && k.t >= m && k.l + CW <= R.width - m && k.t + CH <= R.height - m;
        if (hits(card)) {
          const left = cl(t.l, m, R.width - CW - m);
          const top = cl(t.t, m, R.height - CH - m);
          const clear = [
            { l: left, t: t.b + gap }, { l: left, t: t.t - CH - gap }, { l: t.r + gap, t: top }, { l: t.l - CW - gap, t: top },
            { l: R.width - CW - m, t: m + 44 }, { l: m, t: m + 44 }, { l: R.width - CW - m, t: R.height - CH - m }, { l: m, t: R.height - CH - m },
          ].find((k) => fits(k) && !hits(k));
          if (clear) card = clear;
        }
      }
    }
    const key = [hl.l, hl.t, hl.w, hl.h, card.l, card.t, pt.x, pt.y, pt.on ? 1 : 0].map(Math.round).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.setState({ hl, card, pt });
  }

  soon = () => { this.lastKey = null; this.later(() => this.measure(), 0); this.later(() => this.measure(), 60); this.later(() => this.measure(), 300); };

  blocked = () => { const s = this.steps[this.state.step]; return !!(s.need && !s.need(this.state)); };

  go = (i) => {
    const s = this.steps[i];
    const patch = { step: i };
    if (s.tab) patch.tab = s.tab;
    if (!s.keepBuild) patch.buildOpen = false;
    this.setState(patch);
    this.soon();
  };

  // After any action: if the current step is satisfied and auto, move on.
  check = () => {
    clearTimeout(this.autoT);
    this.autoT = setTimeout(() => { const s = this.steps[this.state.step]; if (this.state.open && s.auto && s.need && s.need(this.state)) this.go(this.state.step + 1); else this.soon(); }, 420);
  };

  act = (patch) => { this.setState(patch); this.check(); };

  next = () => { if (this.blocked()) return; if (this.state.step >= this.steps.length - 1) this.close(); else this.go(this.state.step + 1); };

  prev = () => this.go(Math.max(0, this.state.step - 1));

  // Leaving the tour opens the real project.
  close = () => {
    if (this.closing) return;
    this.closing = true;
    this.setState({ open: false });
    if (this.props.onClose) this.props.onClose();
  };

  // Clicking the @bart line types the question and sends it.
  fillQ = () => {
    if (this.fillingQ || this.state.answer !== 'none') return;
    this.fillingQ = true;
    const q = 'what is mathetic.com about?';
    for (let n = 1; n <= q.length; n += 1) this.later(() => this.setState({ q: q.slice(0, n) }), n * 30);
    this.later(() => { this.fillingQ = false; this.ask(q); }, q.length * 30 + 450);
  };

  // Clicking the field types the link in and adds it: nothing to type.
  fillUrl = () => {
    if (this.filling || this.state.added) return;
    this.filling = true;
    const url = 'https://mathetic.com';
    for (let n = 1; n <= url.length; n += 1) this.later(() => this.setState({ url: url.slice(0, n) }), n * 28);
    this.later(() => { this.filling = false; this.addSite(url); }, url.length * 28 + 450);
  };

  addSite = (raw) => {
    const v = (raw || '').trim();
    if (!v) return;
    const host = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0] || v;
    this.act({ added: true, site: host, url: '', addHover: false, urlFocus: false });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };

  ask = (text) => {
    const t = (text || '').trim();
    if (!t) return;
    this.setState({ askedQ: t, q: '', answer: 'thinking', askDoing: 'Reading mathetic.com', askSteps: 1 });
    this.soon();
    this.later(() => this.setState({ askDoing: 'Thinking', askSteps: 2 }), 1100);
    this.later(() => { this.setState({ answer: 'done' }); this.soon(); this.check(); }, 2400);
  };

  startBuild = () => {
    if (this.state.bStatus !== 'none') return;
    this.act({ building: true, buildOpen: false, bStatus: 'setting-up', bDoing: 'Setting up', bSteps: 0, bNotes: [] });
    const seq = [
      [1300, { bStatus: 'running', bDoing: 'Reading the workspace', bSteps: 1, bNotes: ['Made engelbart/ in the project folder.'] }],
      [2700, { bDoing: 'Reading mathetic.com', bSteps: 2 }],
      [4100, { bDoing: 'Writing index.html', bSteps: 4 }],
      [5600, { bDoing: 'Running checks', bSteps: 6 }],
      [7000, { bStatus: 'review', building: false, bSteps: 7 }],
    ];
    seq.forEach(([ms, patch]) => this.later(() => { this.setState(patch); this.soon(); }, ms));
  };

  accept = () => {
    if (this.state.bStatus !== 'review') return;
    this.act({ bStatus: 'accepted', bNotes: ['Made engelbart/ in the project folder.', 'Accepted into engelbart/ on main.'] });
  };

  render() {
    const st = this.state;
    const { step, open } = st;
    const total = this.steps.length;
    const cur = this.steps[step];
    const done = cur.need ? cur.need(st) : true;
    const dim = this.props.dim ?? true;
    const wsForced = open && (step === 2 || step === 3) && st.wsSeen;
    const addForced = open && step === 5 && !st.added;
    const isNote = st.tab === 'note';
    const isWorkspace = !isNote;
    const siteActive = st.stageOpen && open && step === 6;
    const wsMenuOpen = st.wsHover || wsForced;
    const addMenuOpen = st.addHover || st.urlFocus || addForced;
    const addOn = st.addHover || st.urlFocus || addForced;
    const showBart = step >= 9 || st.answer !== 'none';
    const showAddr = st.stageOpen || st.live;
    const bWorking = st.bStatus === 'setting-up' || st.bStatus === 'running';
    const qLive = !!st.q.trim();
    const bStatusLabel = ({ 'setting-up': 'Setting up', running: 'Working', review: 'Ready to review', accepted: 'Accepted' })[st.bStatus] || '';
    const projectName = this.props.projectName || 'Engelbart';

    return (
      <div ref={this.rootRef} data-welcome-tour="1" data-screen-label="Welcome tour" data-tour-step={step} style={{ position: 'relative', height: '100%', overflow: 'hidden', display: 'grid', gridTemplateColumns: '300px minmax(0,1fr) minmax(320px,32%)', font: `14px/1.5 ${SANS}`, color: '#171717', background: '#ffffff' }}>
        <style>{TOUR_CSS}</style>

        <aside style={{ position: 'relative', zIndex: 3, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#fafafa', borderRight: '1px solid #eaeaea', boxSizing: 'border-box' }}>
          {/* After the traffic lights the two names share ~90px: both shrink, neither below a few letters. */}
          <div className="title-bar title-lead" style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid #eaeaea', fontSize: 14, color: '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span style={{ flex: 'none', fontWeight: 500, fontSize: 16, color: '#171717', letterSpacing: '-0.2px' }}>Engelbart</span>
            <span style={{ flex: 'none', color: '#c9c9c9' }}>/</span>
            <span title={projectName} style={{ flex: '0 1 auto', minWidth: 36, overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName}</span>
            <span style={{ flex: 'none', color: '#c9c9c9' }}>/</span>
            <span style={{ flex: '0 1 auto', minWidth: 50, overflow: 'hidden', textOverflow: 'ellipsis', color: '#171717' }}>Getting started</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '30px 8px 8px' }}>

            <div onMouseEnter={() => this.act({ wsHover: true, wsSeen: true })} onMouseLeave={() => this.setState({ wsHover: false, newHover: false })} style={{ flex: 'none', position: 'relative', zIndex: 6, marginBottom: 18 }}>
              <div data-tour="wsBox" style={{ padding: '12px 12px 10px', background: '#f2f2f2', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ font: `500 12.5px/1.3 ${SANS}`, color: '#8f8f8f' }}>Workspace</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><WsGlyph size={19} /><span style={{ fontWeight: 600 }}>Getting started</span></div>
              </div>
              {wsMenuOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, paddingTop: 4 }}>
                  <div data-tour="wsMenu" style={{ boxSizing: 'border-box', padding: 4, background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, padding: '0 10px', borderRadius: 6, background: '#f2f2f2' }}>
                      <SearchGlass size={13} />
                      <input placeholder="Search" aria-label="Search workspaces" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: `13px/1.5 ${SANS}`, color: '#171717' }} />
                    </div>
                    <div style={{ padding: '8px 10px', borderRadius: 6, background: '#f2f2f2', fontWeight: 600 }}>Getting started</div>
                    <div className="hov-wash" style={wsRow}>User Interface</div>
                    <div className="hov-wash" style={wsRow}>Agents</div>
                    <div className="hov-wash" style={wsRow}>Library</div>
                    <div data-tour="wsNew" onMouseEnter={() => this.act({ newHover: true, newSeen: true })} onMouseLeave={() => this.setState({ newHover: false })} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px 8px', borderRadius: 6, background: st.newHover ? '#f2f2f2' : 'transparent', cursor: 'pointer', color: st.newHover ? '#171717' : '#8f8f8f', transition: 'background 120ms, color 120ms' }}>
                      <span style={{ width: 13, textAlign: 'center', fontSize: 15, lineHeight: 1 }}>+</span><span>New</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 2px', padding: '0 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#ffffff' }}>
              <SearchGlass size={16} />
              <input placeholder="Search" aria-label="Search the library" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, background: 'transparent', font: `14px/1.5 ${SANS}`, color: '#171717' }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <span style={{ flex: 1, padding: '10px 10px 4px', fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, color: '#8f8f8f' }}>Notes</span>
              <span style={{ margin: '10px 10px 4px 0', fontSize: 11.5, lineHeight: 1.4 }}>Collapse all</span>
            </div>
            <div onClick={() => this.act({ tab: 'note', buildOpen: false })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 6, cursor: 'pointer' }}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round' }}><path d={NOTE_ICON} /></svg>
              <span style={{ fontWeight: 500 }}>Welcome!</span>
            </div>

            <div style={sectionLabel}>Websites</div>
            {st.added && (
              <div data-tour="siteRow" className="hov-wash" onClick={() => this.act({ stageOpen: true })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: siteActive ? '#ffffff' : 'transparent', border: `1px solid ${siteActive ? '#eaeaea' : 'transparent'}`, transition: 'background 120ms', animation: RISE }}>
                <Globe size={16} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.site}</span>
              </div>
            )}
            <div style={sectionLabel}>GitHub</div>
            <div style={sectionLabel}>Files</div>
            <div style={sectionLabel}>Sub-Workspaces</div>

            <div onMouseEnter={() => this.act({ addHover: true, addSeen: true })} onMouseLeave={() => this.setState({ addHover: false })} style={{ flex: 'none', position: 'relative', marginTop: 8 }}>
              <div data-tour="addRow" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: addOn ? '#f2f2f2' : 'transparent', cursor: 'pointer', transition: 'background 120ms' }}>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#171717" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="9" cy="9" r="7.5" /><path d="M9 5.5v7 M5.5 9h7" /></svg>
                <span>Add context</span>
              </div>
              {addMenuOpen && (
                <div style={{ position: 'absolute', zIndex: 6, left: 0, right: 0, ...(st.addUp ? { bottom: '100%', paddingBottom: 4 } : { top: '100%', paddingTop: 4 }) }}>
                  <div data-tour="addMenu" style={{ boxSizing: 'border-box', padding: 10, background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, padding: '0 10px', border: '1px solid #eaeaea', borderRadius: 6 }}>
                      <SearchGlass size={13} />
                      <input placeholder="Search" aria-label="Search context" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: `14px/1.5 ${SANS}`, color: '#171717' }} />
                    </div>
                    <div className="hov-wash" style={menuRow}>
                      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round', strokeLinecap: 'round' }}><path d={NOTE_ICON} /></svg>Note
                    </div>
                    <div className="hov-wash" style={menuRow}><WsGlyph size={14} width={1.4} />Sub-Workspace</div>
                    <div style={{ height: 1, margin: '6px 0', background: '#eaeaea' }} />
                    <div data-tour="urlField" style={{ display: 'flex', alignItems: 'center', padding: '0 10px', border: `1px solid ${st.urlFocus ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, background: '#fafafa', transition: 'border-color 120ms' }}>
                      <input
                        value={st.url}
                        onChange={(e) => this.setState({ url: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); this.addSite(st.url); } }}
                        onFocus={() => { this.setState({ urlFocus: true }); this.fillUrl(); }}
                        onBlur={() => this.later(() => this.setState({ urlFocus: false }), 150)}
                        placeholder="Upload URL or path"
                        aria-label="Upload URL or path"
                        spellCheck={false}
                        style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: `14px/1.5 ${SANS}`, color: '#171717' }}
                      />
                    </div>
                    <div className="hov-wash" style={{ ...menuRow, marginTop: 4 }}>
                      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round' }}><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>Choose from disk…
                    </div>
                    <div className="hov-wash" style={menuRow}>
                      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4 M9 18c-4.51 2-5-2-7-2" /></svg>Add from GitHub…
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }}>
              <WsGlyph size={14} width={1.4} />
              <span style={{ flex: 1 }}>User Interface</span>
              <span style={{ color: '#4d4d4d' }}>→</span>
            </div>
          </div>
        </aside>

        <main style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div className="title-bar" style={{ flex: 'none', height: 44, boxSizing: 'border-box', background: '#fafafa', borderBottom: '1px solid #eaeaea', display: 'flex', alignItems: 'flex-end', gap: 2, padding: '0 12px' }}>
            <div data-tour="wsTab" data-no-drag="1" onClick={() => this.act({ tab: 'workspace' })} style={{ height: 34, marginBottom: -1, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', borderRadius: '8px 8px 0 0', background: isNote ? 'transparent' : '#ffffff', border: `1px solid ${isNote ? 'transparent' : '#eaeaea'}`, borderBottom: 0, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
              <WsGlyph size={13} stroke="#4d4d4d" width={1.4} />Workspace
            </div>
            <div data-no-drag="1" onClick={() => this.act({ tab: 'note', buildOpen: false })} style={{ height: 34, marginBottom: -1, display: 'flex', alignItems: 'center', gap: 16, padding: '0 12px', borderRadius: '8px 8px 0 0', background: isNote ? '#ffffff' : 'transparent', border: `1px solid ${isNote ? '#eaeaea' : 'transparent'}`, borderBottom: 0, fontSize: 13, cursor: 'pointer' }}>
              Welcome!<span style={{ color: '#8f8f8f', fontSize: 12 }}>×</span>
            </div>
            <div style={{ height: 34, display: 'flex', alignItems: 'center', padding: '0 10px', fontSize: 16 }}>+</div>
          </div>

          <div data-scroller="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '40px 32px 60px' }}>
            {isNote && (
              <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', fontSize: 16, lineHeight: 1.7 }}>
                <div data-tour="noteBody" style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontSize: 24, fontWeight: 500, letterSpacing: '-0.4px', lineHeight: 1.25 }}>Welcome!</div>
                  <p style={{ margin: '20px 0 0', textWrap: 'pretty' }}>This is a note. Notes are plain markdown files in your project folder, and the sidebar lists what this topic can see.</p>
                  <p style={{ margin: '28px 0 0', textWrap: 'pretty' }}>The Workspace tab is this topic's own document. Add papers, folders and notes from the sidebar with + Context and + Folder.</p>
                </div>

                {showBart && (
                  <div data-tour="bartArea" style={{ marginTop: 24, display: 'flex', flexDirection: 'column', fontSize: 16, lineHeight: 1.6, animation: RISE }}>
                    {st.answer === 'none' && (
                      // The whole line takes the click: in a narrow window the field between "@bart" and the model has no width.
                      <div data-tour="bartLine" onClick={() => { if (this.bartInput.current) this.bartInput.current.focus(); }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px 10px', minHeight: 35, background: '#fafafa', borderRadius: 10, marginBottom: 14 }}>
                        <span style={{ flex: 1, minWidth: 0, display: 'flex', gap: 5 }}>
                          <span style={{ flex: 'none', color: '#0070f3', fontWeight: 500 }}>@bart</span>
                          <input ref={this.bartInput} onFocus={this.fillQ} value={st.q} onChange={(e) => this.setState({ q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); this.ask(st.q); } }} placeholder="ask about mathetic.com…" aria-label="Ask Bart" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: `16px/1.6 ${SANS}`, color: '#171717' }} />
                        </span>
                        <span className="hov-bd2" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 8, margin: '-2px -6px 0 0', padding: '2px 2px 2px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#ffffff', transition: 'border-color 120ms' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, font: `13px/1 ${SANS}`, color: '#4d4d4d', whiteSpace: 'nowrap' }}><ModelWord /></span>
                          <button type="button" onClick={() => this.ask(st.q)} aria-label="Send" style={{ flex: 'none', width: 26, height: 26, padding: 0, border: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: qLive ? '#0070f3' : '#eaeaea', color: qLive ? '#ffffff' : '#8f8f8f', cursor: 'pointer', transition: 'background 160ms' }}><SendArrow /></button>
                        </span>
                      </div>
                    )}
                    {st.answer !== 'none' && (
                      <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px 4px', minHeight: 35, background: '#fafafa', borderRadius: '10px 10px 0 0' }}>
                          <span style={{ flex: 1, minWidth: 0 }}><span style={{ color: '#0070f3', fontWeight: 500 }}>@bart</span> {st.askedQ}</span>
                        </div>
                        {st.answer === 'thinking' && (
                          <div style={{ padding: '2px 16px 12px', background: '#fafafa', borderRadius: '0 0 10px 10px', color: '#8f8f8f', font: `13px/1.5 ${SANS}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: '#0070f3', animation: 'tour-thinking 1.2s ease-in-out infinite' }} />
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`${st.askDoing} · Opus High`}</span>
                              <button type="button" className="hov-ink" style={{ ...smallAct, flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>{`${st.askSteps} ${st.askSteps === 1 ? 'step' : 'steps'}`}<Chevron /></button>
                              <button type="button" className="hov-ink" style={{ ...smallAct, flex: 'none' }}>Stop</button>
                            </div>
                          </div>
                        )}
                        {st.answer === 'done' && (
                          <div style={{ display: 'flex', flexDirection: 'column', animation: RISE }}>
                            <div style={{ padding: '8px 16px 12px', background: '#fafafa', color: '#4d4d4d', fontSize: 16, lineHeight: 1.65 }}>
                              <div style={{ padding: '2px 0 2px 12px', borderLeft: '2px solid #dcdcdc', display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'block', minHeight: 26, textWrap: 'pretty' }}>It's the home page of Mathetic, PBC. It gives one definition, <strong style={{ color: '#171717', fontWeight: 600 }}>mathetic, adj.</strong> — concerned with increasing our capacity to learn, think, create, and discover — and names two people.</span>
                                <span style={{ display: 'block', minHeight: 22 }} />
                                <span style={{ display: 'block', minHeight: 26, paddingTop: 8, font: `600 16px/1.5 ${SANS}`, color: '#171717' }}>People</span>
                                <span style={{ display: 'flex', gap: 10, padding: '4px 0' }}><span style={{ flex: 'none', color: '#8f8f8f' }}>•</span><span style={{ flex: 1, minWidth: 0 }}>Hudson Mitchell-Pullman</span></span>
                                <span style={{ display: 'flex', gap: 10, padding: '4px 0' }}><span style={{ flex: 'none', color: '#8f8f8f' }}>•</span><span style={{ flex: 1, minWidth: 0 }}>David Barron</span></span>
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px 10px', background: '#fafafa' }}>
                              <span style={{ flex: 'none', position: 'relative', display: 'inline-flex' }}><button type="button" aria-label="Copy" className="hov-ink-wash" style={answerIcon}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg></button></span>
                              <span style={{ flex: 'none', position: 'relative', display: 'inline-flex', marginRight: 'auto' }}><button type="button" aria-label="Regenerate" className="hov-ink-wash" style={answerIcon}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.930 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg></button></span>
                              <span style={{ flex: '0 1 auto', minWidth: 0, marginRight: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `12px/1.6 ${SANS}`, color: '#8f8f8f' }}>Opus · High · 3 s</span>
                              <span style={{ flex: 'none', position: 'relative', display: 'inline-flex' }}><button type="button" aria-label="Collapse" className="hov-ink-wash" style={answerIcon}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 20 5-5 5 5" /><path d="m7 4 5 5 5-5" /></svg></button></span>
                              <span style={{ flex: 'none', position: 'relative', display: 'inline-flex' }}><button type="button" aria-label="Delete" className="hov-ink-wash" style={answerIcon}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg></button></span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '22px 16px 18px', background: '#fafafa', borderRadius: '0 0 10px 10px' }}>
                              <span style={{ flex: 'none', color: '#0070f3', fontWeight: 500, fontSize: 16, lineHeight: '24px' }}>@bart</span>
                              <span style={{ flex: 1, minWidth: 0, font: `italic 14.5px/24px ${SANS}`, color: '#8f8f8f' }}>Respond…</span>
                              <span style={{ flex: 'none', position: 'relative', display: 'inline-flex', marginTop: -6 }}>
                                <span className="hov-bd2" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#ffffff', cursor: 'pointer', font: `13px/1 ${SANS}`, color: '#171717', transition: 'border-color 120ms' }}>
                                  <span>Opus High</span>
                                  <span style={{ display: 'inline-flex', color: '#8f8f8f' }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></span>
                                  <span style={{ width: 1, height: 14, background: '#eaeaea', margin: '0 2px' }} />
                                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: '#f2f2f2', color: '#8f8f8f' }}><UpArrow /></span>
                                </span>
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {isWorkspace && (
              <div data-tour="wsDoc" style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', fontSize: 16, lineHeight: 1.7, animation: RISE }}>
                <div style={{ fontSize: 24, fontWeight: 500, letterSpacing: '-0.4px', lineHeight: 1.25 }}>Getting started</div>
                <p style={{ margin: '20px 0 0', textWrap: 'pretty' }}>This is the workspace's own document: the plan for this line of work. Build reads it top to bottom and hands it to a coding agent.</p>
                <div style={{ marginTop: 28, fontSize: 19, fontWeight: 500, letterSpacing: '-0.3px', lineHeight: 1.3 }}>Landing page</div>
                <p style={{ margin: '10px 0 0', textWrap: 'pretty' }}>A single page that says what Mathetic is in one line, with a link to <span style={{ color: '#0070f3' }}>@mathetic.com</span> for the rest.</p>
                {st.bStatus !== 'none' && (
                  <div data-tour="buildCard" style={{ margin: '26px 0 14px', padding: '12px 16px 14px', background: '#fafafa', borderRadius: 10, font: `14px/1.6 ${SANS}`, color: '#4d4d4d', animation: RISE }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ flex: 'none', fontWeight: 600, color: '#171717' }}>Build</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#171717' }}>Getting started</span>
                      <span style={{ flex: 'none', fontSize: 12.5, color: '#8f8f8f' }}>Opus · High</span>
                      <span style={{ flex: 'none', fontSize: 12.5, fontWeight: 500, color: st.bStatus === 'review' ? '#0070f3' : '#8f8f8f' }}>{bStatusLabel}</span>
                    </div>
                    {st.bNotes.map((n) => <div key={n} style={{ margin: '4px 0', font: `12.5px/1.5 ${SANS}`, color: '#8f8f8f' }}>{n}</div>)}
                    {(st.bStatus === 'review' || st.bStatus === 'accepted') && (
                      <div style={{ margin: '6px 0', animation: RISE }}>
                        <span style={{ display: 'block', minHeight: 22, textWrap: 'pretty', color: '#4d4d4d', fontSize: 15, lineHeight: 1.65 }}>Built the landing page in engelbart/. One file, <strong style={{ color: '#171717', fontWeight: 600 }}>index.html</strong>: the name, the one-line definition from mathetic.com, and a link to the site for the rest. Checks pass.</span>
                      </div>
                    )}
                    {bWorking && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, font: `13px/1.5 ${SANS}`, color: '#8f8f8f' }}>
                        <span style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: '#0070f3', animation: 'tour-thinking 1.2s ease-in-out infinite' }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.bDoing}</span>
                        {st.bSteps > 0 && <button type="button" className="hov-ink" style={{ ...smallAct, display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>{`${st.bSteps} ${st.bSteps === 1 ? 'step' : 'steps'}`}<Chevron /></button>}
                        <button type="button" className="hov-ink" style={smallAct}>Stop</button>
                      </div>
                    )}
                    {st.bStatus !== 'accepted' && (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12 }}>
                        <input placeholder="Reply…" aria-label="Reply to the Build" spellCheck={false} style={{ flex: 1, minWidth: 0, height: 24, margin: 0, padding: 0, border: 0, background: 'none', font: `15px/1.6 ${SANS}`, color: '#171717' }} />
                        <span className="hov-dim" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: '#f2f2f2', color: '#8f8f8f', cursor: 'pointer' }}><UpArrow /></span>
                      </div>
                    )}
                    {st.bStatus === 'review' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 0 -2px' }}>
                        <button type="button" className="hov-ink" style={smallAct}>Review</button>
                        <button type="button" data-tour="accept" className="hov-ink" onClick={this.accept} style={{ ...smallAct, color: '#0070f3' }}>Accept</button>
                        <button type="button" className="hov-ink" style={smallAct}>Discard</button>
                      </div>
                    )}
                    {st.bStatus === 'accepted' && (
                      <>
                        <button data-tour="preview" type="button" className="hov-ink" onClick={() => this.act({ live: true })} style={{ display: 'block', margin: '8px 0 0', padding: '2px 0', border: 0, background: 'transparent', color: '#525252', font: `12px/1.5 ${SANS}`, textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer' }}>Open preview ↗</button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 0 -2px' }}>
                          <button type="button" className="hov-ink" style={smallAct}>Review</button>
                          <button type="button" className="hov-ink" style={smallAct}>Remove</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div data-tour="footer" style={{ position: 'relative', zIndex: 5, flex: 'none', height: 44, boxSizing: 'border-box', borderTop: '1px solid #eaeaea', padding: '0 32px', display: 'flex', alignItems: 'center' }}>
            <div style={{ width: '100%', maxWidth: 600, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 14, color: '#8f8f8f' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button type="button" className="hov-ink" style={{ ...footWord, marginLeft: -6, color: '#8f8f8f' }}>Copy</button>
                {isWorkspace && (
                  <>
                    <span style={{ position: 'relative', display: 'inline-flex' }}>
                      {st.buildOpen && (
                        <div data-tour="buildPanel" role="dialog" aria-label="Build" style={{ position: 'absolute', zIndex: 5, left: 0, bottom: 'calc(100% + 8px)', width: 'min(420px, calc(100vw - 16px))', boxSizing: 'border-box', padding: '14px 16px 12px', background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left', animation: `rise 160ms ${EASE}` }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ font: `600 15px/1.4 ${SANS}`, color: '#171717' }}>Build</span>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `15px/1.4 ${SANS}`, color: '#4d4d4d' }}>Getting started</span>
                            <button type="button" onClick={() => this.setState({ buildOpen: false })} aria-label="Close" className="hov-ink" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: `18px/1 ${SANS}`, color: '#8f8f8f' }}>×</button>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span style={{ flex: 'none', font: `13px/1.4 ${SANS}`, color: '#8f8f8f' }}>Repository</span>
                            <button type="button" className="hov-wash" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, maxWidth: '100%', padding: '3px 8px 3px 6px', border: '1px solid #eaeaea', borderRadius: 6, background: '#ffffff', cursor: 'pointer', font: `13px/1.4 ${SANS}`, color: '#171717', transition: 'border-color 120ms' }}>
                              <span style={{ flex: 'none', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.540 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.130-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.480 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg></span>
                              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>engelbart</span>
                              <span style={{ flex: 'none', font: `500 10px/1 ${SANS}`, letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>default</span>
                              <span aria-hidden="true" style={{ flex: 'none', font: `12px/1 ${SANS}`, color: '#8f8f8f', position: 'relative', top: -3 }}>⌄</span>
                            </button>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, margin: '0 0 0 -6px' }}>
                            <button type="button" className="hov-wash" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '5px 10px 5px 6px', border: 0, borderRadius: 6, background: 'transparent', color: '#8f8f8f', cursor: 'pointer', font: `14px/1.5 ${SANS}`, transition: 'background 120ms, color 120ms' }}>
                              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}><circle cx="9" cy="9" r="7.5" /><path d="M9 5.5v7 M5.5 9h7" /></svg>
                              <span>Add from library</span>
                            </button>
                          </div>
                          {st.added && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 6px 3px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: `13px/1.4 ${SANS}`, color: '#171717' }}>
                                <span style={{ flex: 'none', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z" /><path d="M1.75 8h12.5" /><path d="M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.550 8 14.25" /><path d="M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25" /></svg></span>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.site}</span>
                                <button type="button" aria-label="Leave it out" className="hov-ink" style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: `14px/1 ${SANS}`, color: '#8f8f8f' }}>×</button>
                              </span>
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ flex: 1, minWidth: 0, font: `12.5px/1.5 ${SANS}`, color: '#8f8f8f' }}>Makes engelbart/ in the project folder, with a history of its own.</span></div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 }}>
                            <label style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 8, font: `13px/1.4 ${SANS}`, color: '#4d4d4d', cursor: 'pointer', userSelect: 'none' }}><input type="checkbox" style={{ margin: 0, accentColor: '#171717', cursor: 'pointer' }} />Automatically clear workspace</label>
                            <span style={{ flex: 'none', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '2px 2px 2px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#ffffff' }}>
                              <button type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: `13px/1 ${SANS}`, color: '#4d4d4d', whiteSpace: 'nowrap' }}><ModelWord /></button>
                              <button data-tour="send" type="button" onClick={this.startBuild} aria-label="Send" style={{ flex: 'none', width: 26, height: 26, padding: 0, border: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0070f3', color: '#ffffff', cursor: 'pointer', transition: 'background 160ms' }}><SendArrow /></button>
                            </span>
                          </div>
                        </div>
                      )}
                      <button data-tour="buildBtn" type="button" className="hov-ink" onClick={() => { if (st.bStatus === 'none') this.act({ buildOpen: true }); }} style={{ ...footWord, color: st.buildOpen || st.building ? '#171717' : '#8f8f8f' }}>Build</button>
                    </span>
                    <button type="button" className="hov-ink" style={{ ...footWord, color: '#8f8f8f' }}>Clear</button>
                  </>
                )}
              </span>
              <span style={{ flex: 1 }} />
            </div>
          </div>
        </main>

        <section data-tour="stage" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: '#fafafa', borderLeft: '1px solid #eaeaea' }}>
          <div className="title-bar" style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', fontSize: 13, color: '#4d4d4d' }}>
            <span style={{ color: '#171717', fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 6 }}>Stage</span>
            <span>Terminal</span>
            <span style={{ flex: 1 }} />
          </div>
          <div style={{ flex: 'none', height: 36, display: 'flex', alignItems: 'flex-end', gap: 12, padding: '0 12px' }}>
            <div style={{ ...stageTab, background: st.live ? 'transparent' : '#ffffff' }}>
              <Globe size={12} stroke="#4d4d4d" />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: st.live ? '#4d4d4d' : '#171717' }}>{st.stageOpen ? st.site : 'New tab'}</span>
              <span style={{ color: '#8f8f8f' }}>×</span>
            </div>
            {st.live && (
              <div style={{ ...stageTab, background: '#ffffff', animation: RISE }}>
                <span style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: '#639b76' }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#171717' }}>engelbart</span>
                <span style={{ color: '#8f8f8f' }}>×</span>
              </div>
            )}
            <span style={{ height: 30, display: 'flex', alignItems: 'center', fontSize: 16 }}>+</span>
            <span style={{ flex: 1 }} />
            <span style={{ height: 30, display: 'flex', alignItems: 'center', fontSize: 13 }}>⤢</span>
          </div>
          <div style={{ flex: 'none', height: 40, boxSizing: 'border-box', background: '#ffffff', borderBottom: '1px solid #eaeaea', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', fontSize: 13, color: '#c9c9c9' }}>
            <span style={{ color: st.stageOpen ? '#4d4d4d' : '#c9c9c9' }}>←</span>
            <span>→</span>
            <span style={{ color: '#4d4d4d' }}>↻</span>
            <span style={{ flex: 1, height: 26, boxSizing: 'border-box', padding: '0 8px', background: '#fafafa', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
              {showAddr && (
                <>
                  <span style={{ padding: '2px 5px', background: '#eaeaea', borderRadius: 3, fontSize: 8.5, fontWeight: 500, letterSpacing: '1.2px', color: '#4d4d4d' }}>{st.live ? 'LOCAL' : 'WEB'}</span>
                  <span style={{ flex: 1, textAlign: 'center', font: "12px/1 'Source Code Pro',ui-monospace,monospace", color: '#171717' }}>{st.live ? 'localhost:5173' : st.site}</span>
                </>
              )}
            </span>
            <span style={{ color: '#4d4d4d' }}>⋮</span>
          </div>
          {!st.stageOpen && !st.live && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
              <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.4px', lineHeight: 1 }}>Engelbart</div>
              <div style={{ padding: '7px 14px', background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 8, fontSize: 13, fontWeight: 500 }}>Choose a file…</div>
            </div>
          )}
          {st.stageOpen && !st.live && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#ffffff', padding: '64px 40px', display: 'flex', flexDirection: 'column', gap: 22, animation: RISE }}>
              <div style={{ font: "400 44px/1.1 Georgia,'Times New Roman',serif", letterSpacing: '-0.5px' }}>Mathetic</div>
              <div style={{ font: "400 17px/1.6 Georgia,'Times New Roman',serif", color: '#171717', maxWidth: '34ch', textWrap: 'pretty' }}><em>Mathetic, adj.</em> — concerned with increasing our capacity to learn, think, create, and discover.</div>
              <div style={{ font: "400 15px/1.7 Georgia,'Times New Roman',serif", color: '#4d4d4d' }}>Hudson Mitchell-Pullman<br />David Barron</div>
            </div>
          )}
          {st.live && (
            <div data-tour="livePage" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#ffffff', display: 'flex', flexDirection: 'column', animation: RISE }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18, padding: '48px 36px' }}>
                <div style={{ font: `700 40px/1.05 ${SANS}`, letterSpacing: '-1px', color: '#171717' }}>Mathetic</div>
                <div style={{ font: `400 17px/1.55 ${SANS}`, color: '#4d4d4d', maxWidth: '32ch', textWrap: 'pretty' }}>Tools that increase our capacity to learn, think, create, and discover.</div>
                {/* The preview is a picture of the built page: its link goes nowhere from here. */}
                <div><a href="https://mathetic.com" onClick={(e) => e.preventDefault()} style={{ font: `500 14px/1 ${SANS}` }}>Visit mathetic.com →</a></div>
              </div>
              <div style={{ flex: 'none', padding: '16px 36px', borderTop: '1px solid #eaeaea', font: `12px/1.5 ${SANS}`, color: '#8f8f8f' }}>Mathetic, PBC</div>
            </div>
          )}
        </section>

        {open && (
          <>
            <div style={{ position: 'absolute', zIndex: 21, pointerEvents: 'none', left: st.hl.l, top: st.hl.t, width: st.hl.w, height: st.hl.h, borderRadius: 10, border: cur.target ? '1.5px solid #171717' : '0 solid transparent', boxShadow: dim ? '0 0 0 9999px rgba(10,10,10,0.24)' : 'none', transition: `left 260ms ${EASE}, top 260ms ${EASE}, width 260ms ${EASE}, height 260ms ${EASE}` }} />
            <div aria-hidden="true" data-tour-hand="1" style={{ position: 'absolute', zIndex: 23, pointerEvents: 'none', left: st.pt.x, top: st.pt.y, opacity: open && st.pt.on ? 1 : 0, transition: `left 420ms ${EASE}, top 420ms ${EASE}, opacity 200ms ${EASE}` }}>
              <svg width="40" height="47" viewBox="0 0 24 28" style={{ display: 'block', margin: '-3px 0 0 -16px', overflow: 'visible' }}>
                <path d="M8 3.5a1.75 1.75 0 0 1 3.5 0V10.2a1.75 1.75 0 0 1 3.5 0V11.5a1.75 1.75 0 0 1 3.5 0V12.5a1.75 1.75 0 0 1 3.5 0V18c0 4-2.6 7-6.5 7H12c-2.2 0-3.6-.9-4.8-2.3L3.4 18.2a1.8 1.8 0 0 1 2.6-2.5L8 17.6z" fill="#ffffff" stroke="#171717" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M11.5 10.6v3.9M15 11.8v2.9M18.5 12.8v2.4" fill="none" stroke="#171717" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </div>
            <div ref={this.cardRef} role="dialog" aria-label="Welcome tour" data-no-drag="1" data-tour-card="1" style={{ position: 'absolute', zIndex: 22, left: st.card.l, top: st.card.t, width: 320, boxSizing: 'border-box', padding: '16px 18px 14px', background: '#ffffff', border: '1px solid #eaeaea', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, transition: `left 260ms ${EASE}, top 260ms ${EASE}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><MicroLabel>{`Step ${step + 1} of ${total}`}</MicroLabel></div>
              <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.2px', lineHeight: 1.3 }}>{cur.title}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.7, color: '#4d4d4d', textWrap: 'pretty' }}>{done && cur.after ? cur.after : cur.body}</div>
              <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontSize: 11, color: '#8f8f8f' }}><br /></span>
                {step > 0 && <span data-tour-back="1" style={{ display: 'contents' }}><Button size="sm" onClick={this.prev}>Back</Button></span>}
                <span data-tour-next="1" style={{ display: 'contents' }}><Button variant="filled" size="sm" disabled={!done} onClick={this.next}>{step === total - 1 ? 'Done' : 'Next ›'}</Button></span>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
}

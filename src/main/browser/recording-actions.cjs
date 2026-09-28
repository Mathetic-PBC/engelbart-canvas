'use strict';

// Reduce rrweb 2.x's wire events locally. Node IDs only mean something in their
// document segment; labels are resolved before later mutations can change them.
const MAX_ACTIONS = 40, MAX_CHARS = 8000, MAX_NODES = 50000, MAX_BUFFER = 400;
const ATTRS = ['id', 'for', 'aria-label', 'aria-labelledby', 'role', 'title', 'placeholder', 'type', 'contenteditable', 'class', 'data-private', 'data-rr-is-password', 'hidden', 'aria-hidden', 'open'];
const clean = (value, max = 100) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const editable = n => n && (['input', 'textarea', 'select'].includes(n.tag) || (n.attrs.contenteditable != null && n.attrs.contenteditable !== 'false'));
const control = n => n && (['button', 'a', 'input', 'textarea', 'select', 'summary', 'canvas'].includes(n.tag) || /^(button|link|tab|menuitem|checkbox|radio|switch|slider|combobox|textbox)$/.test(n.attrs.role));

// Keep the endpoints and spread the remaining budget over the entire recording.
// Prefer episode boundaries and observed outcomes, without dropping all actions
// from the middle of a long recording. Omitted counts travel with the summary.
function sample(actions, limit) {
  if (actions.length <= limit) return actions;
  const chosen = new Set([0, actions.length - 1]);
  const milestones = actions.map((a, i) => /^(page|dialog|feedback)$/.test(a.kind) ? i : -1).filter(i => i >= 0);
  const slots = Math.min(Math.floor(limit / 3), milestones.length);
  for (let i = 0; i < slots; i++) chosen.add(milestones[Math.floor(i * milestones.length / slots)]);
  const remaining = actions.map((_, i) => i).filter(i => !chosen.has(i)), room = limit - chosen.size;
  for (let i = 0; i < room; i++) chosen.add(remaining[Math.floor(i * remaining.length / room)]);
  return [...chosen].sort((a, b) => a - b).map(i => actions[i]);
}

function createActionTimeline() {
  const documents = new Map(), secrets = new Set();
  let actions = [], rawEvents = 0, totalActions = 0, interactions = 0, namedInteractions = 0, dropped = 0, startedAt = null, lastInputAt = -Infinity, lastPage = '', limited = false;
  const remember = value => {
    const text = clean(value, 4000);
    if (!text || /^[•*]+$/.test(text)) return;
    if (secrets.size >= 4000) { limited = true; return; }
    secrets.add(text);
  };
  const redact = value => {
    let text = clean(value, 300);
    // Input values are never labels, and any known value echoed into a status or
    // button label is also removed. No passwords, URLs, assets or snapshots go out.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = secret.length < 3
        ? text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'gu'), '$1[value]')
        : text.split(secret).join('[value]');
      // Labels are bounded before redaction; suppress a truncated long value too.
      if (secret.length > 20) { const at = text.indexOf(secret.slice(0, 20)); if (at >= 0) text = text.slice(0, at) + '[value]'; }
    }
    return text.replace(/https?:\/\/[^\s]+/gi, '[link]').replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]').slice(0, 100);
  };
  function state(documentId) {
    if (!documents.has(documentId)) {
      if (documents.size >= 4) documents.delete(documents.keys().next().value);
      documents.set(documentId, { nodes: new Map(), labels: new Set(), ids: new Map(), focused: null });
    }
    return documents.get(documentId);
  }
  function hidden(s, n) {
    for (let depth = 0; n && depth < 100; depth++, n = s.nodes.get(n.parent)) {
      const a = n.attrs;
      if (a['data-private'] != null || a['data-rr-is-password'] != null || /(?:^|\s)rr-(?:mask|block)(?:\s|$)/.test(a.class || '') || a.type === 'password' || a.hidden != null || a['aria-hidden'] === 'true') return true;
    }
    return false;
  }
  function textOf(s, n, includeEditable = false) {
    const stack = [n], parts = []; let count = 0;
    while (stack.length && count++ < 200 && parts.join(' ').length < 300) {
      const item = stack.pop();
      if (!item || hidden(s, item) || ['script', 'style', 'head', 'option'].includes(item.tag) || (!includeEditable && editable(item))) continue;
      if (item.text) parts.push(item.text);
      for (let i = item.children.length - 1; i >= 0; i--) stack.push(s.nodes.get(item.children[i]));
    }
    return clean(parts.join(' '), 300);
  }
  function root(s, n) {
    let id = n?.id;
    for (let depth = 0; n && depth < 100; depth++, n = s.nodes.get(n.parent)) { id = n.id; if (n.type === 0) break; }
    return id;
  }
  function label(s, n) {
    if (!n || hidden(s, n)) return '';
    const a = n.attrs;
    const refs = String(a['aria-labelledby'] || '').split(/\s+/).flatMap(id => [...(s.ids.get(id) || [])].map(i => s.nodes.get(i)).filter(other => root(s, other) === root(s, n)));
    if (refs.length) { const text = clean(refs.map(other => textOf(s, other)).join(' ')); if (text) return text; }
    if (a['aria-label']) return clean(a['aria-label']);
    if (editable(n)) {
      if (a.id) for (const id of s.labels) { const other = s.nodes.get(id); if (other?.attrs.for === a.id && root(s, other) === root(s, n)) { const text = textOf(s, other); if (text) return clean(text); } }
      for (let other = s.nodes.get(n.parent), depth = 0; other && depth++ < 8; other = s.nodes.get(other.parent)) if (other.tag === 'label') return clean(textOf(s, other));
      return clean(a.placeholder || a.title);
    }
    return clean(textOf(s, n) || a.title);
  }
  function index(s, node, parent = null, depth = 0) {
    if (!node || !Number.isSafeInteger(node.id) || depth > 100) return;
    if (s.nodes.size >= MAX_NODES) { limited = true; return; }
    const attrs = Object.fromEntries(ATTRS.filter(key => node.attributes?.[key] != null).map(key => [key, clean(node.attributes[key], 300)]));
    const n = { id: node.id, type: node.type, tag: node.tagName || '', attrs, text: clean(node.textContent, 300), children: [], parent };
    s.nodes.set(n.id, n);
    if (n.tag === 'label') s.labels.add(n.id);
    if (attrs.id) { if (!s.ids.has(attrs.id)) s.ids.set(attrs.id, new Set()); s.ids.get(attrs.id).add(n.id); }
    if (editable(n)) remember(node.attributes?.value);
    for (const child of node.childNodes || []) { index(s, child, n.id, depth + 1); n.children.push(child.id); }
    if (editable(n)) remember(textOf(s, n, true));
  }
  function remove(s, id, depth = 0) {
    const n = s.nodes.get(id); if (!n || depth > 100) return;
    for (const child of [...n.children]) remove(s, child, depth + 1);
    const parent = s.nodes.get(n.parent), at = parent?.children.indexOf(id);
    if (at >= 0) parent.children.splice(at, 1);
    s.labels.delete(id); s.ids.get(n.attrs.id)?.delete(id); s.nodes.delete(id);
  }
  function add(kind, target, at, key = '', named = false) {
    let previous = actions.at(-1);
    // Inline validation can appear between keystrokes; it must not turn one
    // field edit back into dozens of actions.
    if (kind === 'edit') {
      let i = actions.length - 1;
      while (i >= 0 && actions[i].kind === 'feedback') i--;
      previous = actions[i];
    }
    if (previous && previous.kind === kind && previous.key === key && (previous.target === target || kind === 'feedback') && at - previous.end <= (kind === 'edit' ? 10000 : 2000)) {
      previous.target = target; previous.end = at; previous.count++; return;
    }
    actions.push({ kind, target, at, end: at, key, named, count: 1 }); totalActions++;
    if (actions.length > MAX_BUFFER) { const kept = sample(actions, MAX_BUFFER / 2); dropped += actions.length - kept.length; actions = kept; }
  }
  function target(s, id) {
    let n = s.nodes.get(id);
    for (let depth = 0; n && depth < 12; depth++, n = s.nodes.get(n.parent)) if (control(n) || editable(n)) return n;
    return s.nodes.get(id);
  }
  function outcome(s, id, at) {
    if (at - lastInputAt > 4000) return;
    for (let n = s.nodes.get(id), depth = 0; n && depth++ < 12; n = s.nodes.get(n.parent)) {
      if (hidden(s, n) || editable(n)) return;
      const dialog = n.tag === 'dialog' || n.attrs.role === 'dialog' || n.attrs.role === 'alertdialog';
      const feedback = /^(alert|status)$/.test(n.attrs.role);
      if (!dialog && !feedback) continue;
      if (n.tag === 'dialog' && n.attrs.open == null) return;
      const description = label(s, n);
      if (description) add(dialog ? 'dialog' : 'feedback', description, at, String(n.id));
      return;
    }
  }
  function batch(batch) {
    const s = state(batch.documentId);
    for (const e of batch.events) {
      rawEvents++; startedAt ??= e.timestamp;
      const d = e.data || {}, at = Math.max(0, e.timestamp - startedAt);
      if (e.type === 4) {
        let route; try { const url = new URL(d.href); if (!['http:', 'https:'].includes(url.protocol)) continue; route = url.pathname; } catch { continue; }
        if (route !== lastPage) { add('page', clean(route), at); lastPage = route; }
      } else if (e.type === 2) {
        s.nodes.clear(); s.labels.clear(); s.ids.clear(); index(s, d.node);
      } else if (e.type === 3 && d.source === 0) {
        const changed = new Set();
        for (const r of d.removes || []) remove(s, r.id);
        for (const a of d.adds || []) {
          index(s, a.node, a.parentId);
          const parent = s.nodes.get(a.parentId);
          if (parent) { const next = parent.children.indexOf(a.nextId); parent.children.splice(next < 0 ? parent.children.length : next, 0, a.node.id); }
          changed.add(a.node?.id);
        }
        for (const t of d.texts || []) { const n = s.nodes.get(t.id); if (n) { n.text = clean(t.value, 300); changed.add(n.id); } }
        for (const a of d.attributes || []) {
          const n = s.nodes.get(a.id); if (!n) continue;
          if (editable(n)) remember(a.attributes?.value);
          for (const key of ATTRS) if (Object.hasOwn(a.attributes || {}, key)) {
            if (key === 'id') s.ids.get(n.attrs.id)?.delete(n.id);
            if (a.attributes[key] === null) delete n.attrs[key]; else n.attrs[key] = clean(a.attributes[key], 300);
            if (key === 'id' && n.attrs.id) { if (!s.ids.has(n.attrs.id)) s.ids.set(n.attrs.id, new Set()); s.ids.get(n.attrs.id).add(n.id); }
          }
          changed.add(n.id);
        }
        for (const id of changed) {
          let n = s.nodes.get(id), field = null;
          for (let depth = 0; n && depth++ < 12; n = s.nodes.get(n.parent)) if (editable(n)) { field = n; break; }
          if (field) {
            remember(textOf(s, field, true));
            if (field.id === s.focused && !hidden(s, field)) {
              const description = label(s, field);
              interactions++; if (description) namedInteractions++; lastInputAt = at;
              add('edit', description || 'unlabeled field', at, `${batch.documentId}:${field.id}`, !!description);
            }
            continue;
          }
          outcome(s, id, at);
        }
      } else if (e.type === 3 && d.source === 2 && [5, 6].includes(d.type)) {
        s.focused = d.type === 5 ? target(s, d.id)?.id : null;
      } else if (e.type === 3 && (d.source === 5 || (d.source === 2 && [2, 3, 4].includes(d.type)))) {
        if (d.source === 5) remember(d.text);
        const n = target(s, d.id);
        if (!n || hidden(s, n) || (!control(n) && !editable(n))) continue;
        // Focus clicks preceding typing add no intent. The input event supplies the action.
        if (d.source === 2 && editable(n)) continue;
        const description = label(s, n), kind = d.source === 5 ? 'edit' : d.type === 3 ? 'context-menu' : d.type === 4 ? 'double-click' : 'click';
        interactions++; if (description) namedInteractions++; lastInputAt = at;
        add(kind, description || (editable(n) ? 'unlabeled field' : n.tag === 'canvas' ? 'canvas (contents unknown)' : 'unlabeled element'), at, `${batch.documentId}:${n.id}`, !!description);
      }
      // Pointer paths, scrolling, focus/blur, CSS, animations, assets and canvas
      // pixels are deliberately not sent to a text model.
    }
  }
  function result() {
    const selected = sample(actions, MAX_ACTIONS);
    const timeline = selected.map(a => ({ seconds: Math.round(a.at / 1000), action: a.kind, target: redact(a.target), ...(a.count > 1 ? { updates: a.count } : {}) }));
    const result = { version: 1, rawEvents, interactions, namedInteractions, actionCount: totalActions, omittedActions: dropped + actions.length - selected.length, limited, timeline };
    while (JSON.stringify(result).length > MAX_CHARS && timeline.length > 2) { timeline.splice(Math.floor(timeline.length / 2), 1); result.omittedActions++; }
    return result;
  }
  return { batch, result };
}

module.exports = { createActionTimeline, MAX_ACTIONS, MAX_CHARS };

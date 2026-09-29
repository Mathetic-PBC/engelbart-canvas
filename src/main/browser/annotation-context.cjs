'use strict';

// Serialized into the annotation helper's isolated world. A bounded, read-only
// DOM snapshot, not a screenshot, a page export, or access to application state.
function elementContext(el) {
  const limit = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const parent = node => node.parentElement || node.getRootNode()?.host || null;
  const omit = 'script,style,noscript,template,input[type="hidden"],[hidden],[aria-hidden="true"],[data-private],[data-sensitive],[data-engelbart-private],.rr-block,.rr-mask,[data-engelbart-annotations],[contenteditable]:not([contenteditable="false"])';
  function excluded(node) {
    for (let current = node; current; current = parent(current)) {
      if (current.matches(omit)) return true;
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    }
    return false;
  }
  function text(node, max = 1200) {
    if (!node || excluded(node)) return '';
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let result = '', visited = 0;
    for (let next = walker.nextNode(); next && visited++ < 600 && result.length < max; next = walker.nextNode()) {
      if (!excluded(next.parentElement) && !next.parentElement.closest('input,textarea,select,option')) result += ` ${next.data}`;
    }
    return limit(result, max);
  }
  function address(value) {
    try {
      const url = new URL(value, el.ownerDocument.baseURI);
      return /^https?:$/.test(url.protocol) ? (url.origin + url.pathname).slice(0, 2048) : '';
    } catch { return ''; }
  }
  function attributes(node) {
    const result = {};
    for (const name of ['id', 'role', 'type', 'name', 'aria-label', 'aria-describedby', 'placeholder']) {
      if (node.hasAttribute(name)) result[name] = limit(node.getAttribute(name));
    }
    for (const name of ['href', 'action', 'formaction']) {
      if (node.hasAttribute(name)) result[name] = address(node.getAttribute(name));
    }
    for (const name of ['disabled', 'required', 'multiple']) if (node.hasAttribute(name)) result[name] = true;
    if (node.localName === 'button') result.type = node.type;
    return result;
  }
  function describe(node) {
    return excluded(node) ? { tag: node.localName, private: true } : {
      tag: node.localName, attributes: attributes(node), text: text(node, 400),
      labels: [...(node.labels || [])].slice(0, 5).map(label => text(label, 160)),
    };
  }
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let visited = 0, remaining = 7000;
  function html(node, depth = 0) {
    if (visited++ >= 140 || depth > 8 || remaining <= 0) return '';
    if (node.nodeType === 3) {
      if (excluded(node.parentElement) || node.parentElement.closest('input,textarea,select,option')) return '';
      const value = escape(limit(node.data, Math.min(400, remaining)));
      remaining -= value.length; return value;
    }
    if (node.nodeType !== 1 || excluded(node)) return '';
    const attrs = Object.entries(attributes(node)).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    const start = `<${node.localName}${attrs}>`;
    remaining -= start.length;
    const children = node.matches('input,textarea,select,iframe,frame') ? '' : [...node.childNodes].slice(0, 100).map(child => html(child, depth + 1)).join('');
    return `${start}${children}</${node.localName}>`;
  }
  let surrounding = el;
  for (let current = parent(el), depth = 0; current && depth++ < 4; current = parent(current)) {
    surrounding = current;
    if (current.matches('form,section,article,dialog,main,[role="dialog"]')) break;
  }
  const form = el.form || el.closest('form');
  return {
    element: describe(el),
    surroundingText: text(surrounding, 2400),
    surroundingHtml: html(surrounding).slice(0, 8000),
    form: form && !excluded(form) ? {
      method: limit(form.method, 16), action: address(form.action),
      fields: [...form.elements].slice(0, 20).map(describe),
    } : null,
    limitations: 'DOM evidence only: no click was performed, no event handlers or server behavior were inspected. Input values, hidden and marked-private content are omitted.',
  };
}

module.exports = { elementContext };

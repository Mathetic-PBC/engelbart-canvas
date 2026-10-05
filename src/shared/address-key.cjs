'use strict';
// How one address is spelled for "is it open already": the Stage's tabs (renderer/model/stage.js) and the tabs main keeps
// for it in state.json (main/store/projects.cjs cleanStage, MATH-10).

/** http or https, www. or not, a trailing slash, a #fragment: one address. Anything that is no URL is as it came. */
function addressKey(value) {
  const v = String(value || '').trim();
  if (!v || v === 'about:blank') return '';
  let u;
  try { u = new URL(v); } catch { return v; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href.replace(/#.*$/, '');
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

module.exports = { addressKey };

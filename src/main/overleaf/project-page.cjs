'use strict';

// Only allowlisted catalog metadata already supplied to Overleaf's own project
// page. Never read cookies, CSRF fields, project contents, or page JS globals.
function snapshotOverleaf(accountOnly = false, origin = 'https://www.overleaf.com') {
  if (location.origin !== origin || !/^\/project(?:\/[a-f0-9]{24})?\/?$/i.test(location.pathname)) return { kind: 'unavailable' };
  const meta = name => document.querySelector(`meta[name="${name}"]`)?.content;
  const scalar = name => { const raw = meta(name); try { const value = JSON.parse(raw); return typeof value === 'string' ? value : raw; } catch { return raw; } };
  const id = scalar('ol-user_id'), email = scalar('ol-usersEmail');
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id) || typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { kind: 'loading' };
  const account = { id: id.toLowerCase(), email };
  if (accountOnly) return { kind: 'account', account };
  if (!/^\/project\/?$/.test(location.pathname) || location.search) return { kind: 'unavailable' };
  const raw = meta('ol-prefetchedProjectsBlob');
  if (!raw) return { kind: 'loading', account };
  if (raw.length > 16 * 1024 * 1024) return { kind: 'layout', account };
  let blob;
  try { blob = JSON.parse(raw); } catch { return { kind: 'layout', account }; }
  if (!Array.isArray(blob?.projects) || !Number.isSafeInteger(blob.totalSize) || blob.totalSize < 0) return { kind: 'layout', account };
  // The website can render only the first 20 rows even though it embeds the
  // entire catalog. Check totalSize so a partial batch never looks complete.
  if (blob.projects.length !== blob.totalSize || blob.totalSize > 10000) return { kind: 'incomplete', account };
  const projects = [], seen = new Set();
  for (const item of blob.projects) {
    if (typeof item?.id !== 'string' || !/^[a-f0-9]{24}$/i.test(item.id) || typeof item.name !== 'string' || !item.name.trim() ||
        typeof item.lastUpdated !== 'string' || !Number.isFinite(Date.parse(item.lastUpdated)) ||
        typeof item.trashed !== 'boolean' || typeof item.archived !== 'boolean' || seen.has(item.id.toLowerCase())) return { kind: 'layout', account };
    seen.add(item.id.toLowerCase());
    if (item.trashed) continue;
    projects.push({ id: item.id.toLowerCase(), name: item.name.slice(0, 512), modifiedTime: new Date(item.lastUpdated).toISOString(), archived: item.archived });
  }
  projects.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { kind: 'ready', account, projects };
}
module.exports = { snapshotOverleaf };

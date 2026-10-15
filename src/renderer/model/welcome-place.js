// The import's "Open library" (2026-10-14): which workspace of the project it lands on, and which tab (App.jsx openLibrary).

/**
 * Where "Open library" lands in `tree`: the workspace the run was given (`given`, when main says which and the tree has
 * it), else the newest workspace named Welcome ("Welcome", "Welcome 2", …: onboarding's and the guided setup's), else the
 * one open (`current`), else the first. Its page opens; a "Welcome!" note there opens instead when the workspace is not a
 * Welcome one (an older onboarding's Getting started). → { workspaceId, tab }
 */
export function welcomePlace(tree, { given = null, current = null } = {}) {
  const all = [];
  const walk = (list) => { for (const node of list || []) { all.push(node); walk(node.children); } };
  walk(tree && tree.workspaces);
  const byId = (id) => (id ? all.find((node) => node.id === id) : null) || null;
  const number = (node) => Number((/ (\d+)$/.exec(String(node.name || '').trim()) || [0, 1])[1]);
  const welcome = all.filter((node) => /^welcome( to engelbart)?!?( \d+)?$/i.test(String(node.name || '').trim())).sort((a, b) => number(b) - number(a))[0] || null;
  const workspace = byId(given) || welcome || byId(current) || all[0] || null;
  if (!workspace) return { workspaceId: null, tab: null };
  const note = /^welcome/i.test(String(workspace.name || '')) ? null
    : ((tree && tree.notes) || []).find((one) => one.workspaceId === workspace.id && /^welcome!?$/i.test(String(one.name || '').trim()));
  return { workspaceId: workspace.id, tab: note ? { id: note.id, title: note.name } : null };
}

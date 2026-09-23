// The repository list of the + menu's GitHub view (2026-09-22). Pure: the App's repositories and the library come in,
// the rows go out; workspace/GithubPane.jsx draws them and the screen adds or links the one picked.

const key = (url) => String(url || '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');

/** The library row that already is this repository: the same GitHub id, else the same address. */
export function heldRow(repo, library) {
  const address = key(repo.url);
  return library.find((row) => (row.github_id && String(row.github_id) === String(repo.id)) || (row.url && key(row.url) === address)) || null;
}

/**
 * Rows: { repo, row (the library's, or null), here (on this workspace's rail) }, filtered by every word typed against the
 * name and the description, in the order GitHub's list came (most recently pushed first).
 */
export function githubRows({ repos, query, library, inRail }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (repos || [])
    .filter((repo) => { const hay = `${repo.fullName} ${repo.description || ''}`.toLowerCase(); return words.every((word) => hay.includes(word)); })
    .map((repo) => { const row = heldRow(repo, library); return { repo, row, here: !!row && inRail(row.id) }; });
}

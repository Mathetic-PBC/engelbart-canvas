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

// A repository typed or pasted into the search (2026-10-06): any public one, not only those the App can see. `owner/name`,
// `github.com/owner/name`, its https address, or its git remote; owner and name spelled as GitHub allows them.
const TYPED = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([a-z\d](?:[a-z\d-]{0,38}))\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * The row for a repository typed into the search, shaped as githubRows' are, when it is not one of `rows` already: its
 * `repo` has no id (the library identifies it as it adds it) and `typed: true`. Null when the search is not a repository.
 */
export function typedRepo({ query, rows = [], library = [], inRail = () => false }) {
  const match = String(query || '').trim().match(TYPED);
  if (!match || match[2] === '.' || match[2] === '..') return null;
  const fullName = `${match[1]}/${match[2]}`;
  if (rows.some((entry) => entry.repo.fullName.toLowerCase() === fullName.toLowerCase())) return null;
  const repo = { id: null, owner: match[1], fullName, url: `https://github.com/${fullName}`, private: false, typed: true };
  const row = heldRow(repo, library);
  return { repo, row, here: !!row && inRail(row.id), typed: true };
}

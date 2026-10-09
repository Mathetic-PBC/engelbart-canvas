// How a library row is shown, from the two things it says about itself: `type`, what it is (a
// file's format, or folder / website / image), and `tags`, what was inferred about it (paper, git,
// note). The type is never read for meaning it does not have: whether a row is a note, a paper or
// a repository is asked of its tags.

export const hasTag = (row, tag) => !!row && Array.isArray(row.tags) && row.tags.includes(tag);

/** Written in Engelbart: opens as a tab, is renamed through its project, is read whole by Copy. */
export const isNote = (row) => hasTag(row, 'note');

const DATA_TYPES = new Set(['csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx']);

/** Which glyph stands for the row and where it sorts. A repository keeps its mark whether it is an address or a folder; every data format shares one. */
export function kindKey(row) {
  if (!row) return 'note';
  if (hasTag(row, 'git')) return 'git';
  if (row.type === 'md') return isNote(row) ? 'note' : 'md';
  return DATA_TYPES.has(row.type) ? 'data' : row.type;
}

/** The library rail's order; a kind that is not listed (image) sorts last. */
export const KIND_ORDER = ['note', 'md', 'docx', 'pdf', 'git', 'folder', 'website', 'html', 'data'];
export const kindRank = (row) => { const at = KIND_ORDER.indexOf(kindKey(row)); return at < 0 ? KIND_ORDER.length : at; };

/** The words beside a row: its type ("link" for a website), then its tags. */
export function kindLabel(row) {
  return [row.type === 'website' ? 'link' : row.type, ...(Array.isArray(row.tags) ? row.tags : [])].join(' · ');
}

/**
 * The sidebar Library panel's chips (2026-10-09), in their order: `noun` names what a chip holds in its heading and its
 * empty line ("Recent papers", "No papers match"). Only one is on at a time; All is the default.
 */
export const LIBRARY_CHIPS = [
  { id: 'all', label: 'All', noun: '' },
  { id: 'notes', label: 'Notes', noun: 'notes' },
  { id: 'papers', label: 'Papers', noun: 'papers' },
  { id: 'repos', label: 'Repos', noun: 'repos' },
  { id: 'web', label: 'Web', noun: 'web pages' },
  { id: 'files', label: 'Files', noun: 'files' },
];

const CHIP_KINDS = { notes: ['note'], papers: ['pdf'], repos: ['git'], web: ['website', 'html'] };
const CHIPPED = new Set(Object.values(CHIP_KINDS).flat());

/**
 * Whether `row` is under `chip`, by its kindKey: a repository whether address or folder (a website tagged git is a repo,
 * not web); Files is everything no other chip takes (an md that is not a note, docx, a folder, data). A picture is
 * under none, All included: it is its document's.
 */
export function libraryFilter(row, chip = 'all') {
  const key = kindKey(row);
  if (key === 'image') return false;
  if (chip === 'all') return true;
  if (chip === 'files') return !CHIPPED.has(key);
  return (CHIP_KINDS[chip] || []).includes(key);
}

/** How many rows each chip holds: { all, notes, papers, repos, web, files }. */
export function libraryCounts(rows) {
  const counts = Object.fromEntries(LIBRARY_CHIPS.map((chip) => [chip.id, 0]));
  for (const row of rows || []) for (const chip of LIBRARY_CHIPS) if (libraryFilter(row, chip.id)) counts[chip.id] += 1;
  return counts;
}

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
export const KIND_ORDER = ['note', 'md', 'pdf', 'git', 'folder', 'website', 'html', 'data'];
export const kindRank = (row) => { const at = KIND_ORDER.indexOf(kindKey(row)); return at < 0 ? KIND_ORDER.length : at; };

/** The words beside a row: its type ("link" for a website), then its tags. */
export function kindLabel(row) {
  return [row.type === 'website' ? 'link' : row.type, ...(Array.isArray(row.tags) ? row.tags : [])].join(' · ');
}

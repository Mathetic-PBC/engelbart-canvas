// A Build's diff as its card shows it (2026-09-29: the diff streams into the card, as Claude Code and Codex show their
// edits; it replaced the Review dialog). Main sends `{ files, patch, truncated }` (src/main/build/git.cjs diff): the
// files with their counts, and git's unified patch. The card draws rows: a header per file, then its hunks' lines.

const SKIP_RE = /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (from|to) |copy (from|to) )/;
const FILE_RE = /^diff --git a\/(.*) b\/(.*)$/;

/** → { files, adds, dels } over every file of the diff. */
export function diffTotals(files) {
  let adds = 0, dels = 0;
  for (const file of files || []) { adds += file.adds || 0; dels += file.dels || 0; }
  return { files: (files || []).length, adds, dels };
}

/**
 * The rows to draw: { kind: 'file', path, was, adds, dels, binary } then its { kind: 'hunk' | 'add' | 'del' | 'ctx' |
 * 'note', text }. At most `maxLines` lines of code are kept; `cut` is how many were left out.
 */
export function diffRows(diff, { maxLines = 2500 } = {}) {
  const files = new Map((diff && diff.files ? diff.files : []).map((file) => [file.path, file]));
  const rows = [];
  let lines = 0, cut = 0, inHunk = false;
  for (const line of String((diff && diff.patch) || '').split('\n')) {
    const head = FILE_RE.exec(line);
    if (head) {
      const file = files.get(head[2]) || files.get(head[1]) || { path: head[2], adds: 0, dels: 0 };
      rows.push({ kind: 'file', path: file.path, was: file.was || null, adds: file.adds || 0, dels: file.dels || 0, binary: !!file.binary });
      inHunk = false;
      continue;
    }
    if (!rows.length) continue;
    if (!inHunk) {
      if (line.startsWith('@@')) inHunk = true;
      else if (line.startsWith('Binary files')) { rows.push({ kind: 'note', text: 'Binary file' }); continue; }
      else if (SKIP_RE.test(line) || !line) continue;
    }
    if (lines >= maxLines) { cut += 1; continue; }
    lines += 1;
    if (line.startsWith('@@')) rows.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) rows.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line });
    else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(2) });
    else if (line) rows.push({ kind: 'ctx', text: line });
  }
  // a file the patch did not reach (it was cut short) still gets its header
  const shown = new Set(rows.filter((row) => row.kind === 'file').map((row) => row.path));
  for (const file of files.values()) if (!shown.has(file.path)) rows.push({ kind: 'file', path: file.path, was: file.was || null, adds: file.adds || 0, dels: file.dels || 0, binary: !!file.binary });
  return { rows, cut, truncated: !!(diff && diff.truncated) };
}

/** The next [Attachment n] of a Build: after every image its replies have sent and the draft holds. */
export function nextAttachment(messages, draft) {
  let n = 0;
  for (const message of messages || []) for (const image of message.images || []) n = Math.max(n, image.n || 0);
  for (const image of draft || []) n = Math.max(n, image.n || 0);
  return n + 1;
}

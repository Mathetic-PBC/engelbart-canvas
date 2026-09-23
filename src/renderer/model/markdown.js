// A markdown file read on the Stage (2026-09-23): blocks and inline runs as data, drawn by React, so nothing in the file
// is ever parsed as html. Enough of CommonMark for notes and READMEs: headings, paragraphs, bullets and numbers (nested
// by indentation, with task boxes), quotes, fenced code, rules, tables as text; **bold**, *italic*, `code`, [links](…).

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** The file as blocks: { type: 'h', level, text } | { type: 'p', text } | { type: 'li', ordered, marker, depth, checked, text } | { type: 'quote', text } | { type: 'code', lang, text } | { type: 'hr' }. */
export function markdownBlocks(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null;
  const endPara = () => { if (para) { blocks.push({ type: 'p', text: para.join(' ') }); para = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      endPara();
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trim().startsWith(fence[1]); j += 1) body.push(lines[j]);
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      i = j;
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    let m;
    if ((m = line.match(HEADING))) { endPara(); blocks.push({ type: 'h', level: m[1].length, text: m[2] }); continue; }
    if (RULE.test(line)) { endPara(); blocks.push({ type: 'hr' }); continue; }
    if ((m = line.match(ITEM))) {
      endPara();
      const box = m[3] ? /x/i.test(m[3]) : null;
      blocks.push({ type: 'li', ordered: /\d/.test(m[2]), marker: m[2], depth: Math.floor(m[1].replace(/\t/g, '    ').length / 2), checked: box, text: m[4] });
      continue;
    }
    if ((m = line.match(QUOTE))) {
      endPara();
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'quote') last.text += ` ${m[1]}`;
      else blocks.push({ type: 'quote', text: m[1] });
      continue;
    }
    (para = para || []).push(line.trim());
  }
  endPara();
  return blocks;
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** A line's runs: { text, bold?, italic?, code?, href? }. Nesting beyond one level is read as plain text. */
export function inlineRuns(text) {
  const s = String(text || '');
  const runs = [];
  let at = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(s); m; m = INLINE.exec(s)) {
    if (m.index > at) runs.push({ text: s.slice(at, m.index) });
    if (m[1]) runs.push({ text: m[2], code: true });
    else if (m[3] || m[4]) runs.push({ text: m[3] || m[4], bold: true });
    else if (m[5] || m[6]) runs.push({ text: m[5] || m[6], italic: true });
    else if (m[7]) runs.push({ text: m[7], href: m[8] });
    else runs.push({ text: m[9], href: m[9] });
    at = INLINE.lastIndex;
  }
  if (at < s.length) runs.push({ text: s.slice(at) });
  return runs;
}

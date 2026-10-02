import React from 'react';
import { parseLines, inlineHtml, agentOf } from '../model/doc.js';

// What a hidden line is: nothing to read in a preview.
const hidden = (p) => p.type === 'pending' || p.type === 'img' || p.type === 'fence' || p.code === 'open' || p.code === 'close' || (p.type === 'p' && !p.text.trim());

/** Where the last `n` lines that show something begin. */
function tailStart(lines, parsed, n) {
  let left = n;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (hidden(parsed[i])) continue;
    left -= 1;
    if (left === 0) return i;
  }
  return 0;
}

/** A document the way the workspace shows it, read-only: bold, italic, code, links and mentions; tasks and bullets as dashes. */
export default function DocPreview({ text, maxLines, tail, size = 10.5 }) {
  const lines = String(text || '').replace(/^\s*\n/, '').split('\n');
  const parsed = parseLines(lines);
  // `tail`: the document's last lines that hold something, read in the context of the whole (a code block stays one).
  const from = tail ? tailStart(lines, parsed, tail) : 0;
  const shown = maxLines ? lines.slice(from, from + maxLines) : lines.slice(from);
  return (
    <div className="doc-preview" style={{ font: `${size}px/1.45 var(--font-sans)`, color: '#171717', overflowWrap: 'anywhere' }}>
      {shown.map((line, at) => {
        const index = from + at, p = parsed[index];
        if (p.type === 'pending' || p.type === 'img' || p.type === 'fence' || p.code === 'open' || p.code === 'close') return null;
        if (p.code === 'body') return <div key={index} style={{ paddingLeft: '0.7em', borderLeft: '2px solid #eaeaea', font: '0.92em/1.5 var(--font-mono)', color: '#4d4d4d', whiteSpace: 'pre-wrap' }}>{p.text || '\u00a0'}</div>;
        if (p.type === 'code') return <div key={index} style={{ padding: '0 0.6em', background: '#fafafa', font: '0.92em/1.5 var(--font-mono)', whiteSpace: 'pre-wrap' }}>{line || '\u00a0'}</div>;
        if (p.type === 'p' && !p.text.trim()) return <div key={index} style={{ height: '0.6em' }} />;
        const html = { __html: inlineHtml(p.type === 'bart' ? `@${agentOf(p)} ${p.text}` : p.text || '') };
        if (p.type === 'h') return <div key={index} style={{ margin: '0.35em 0 0.15em', fontWeight: 600 }} dangerouslySetInnerHTML={html} />;
        if (p.type === 'todo' || p.type === 'list') {
          const done = p.type === 'todo' && p.done;
          return (
            <div key={index} style={{ display: 'flex', gap: '0.45em', paddingLeft: `${0.6 + p.depth * 0.9}em`, color: done ? '#8f8f8f' : undefined }}>
              <span style={{ flex: 'none' }}>{done ? '✓' : '–'}</span>
              <span style={{ minWidth: 0, textDecoration: done ? 'line-through' : undefined }} dangerouslySetInnerHTML={html} />
            </div>
          );
        }
        const answer = p.type === 'draft' || p.type === 'reply' || p.type === 'quote';
        return <div key={index} style={answer ? { paddingLeft: '0.7em', borderLeft: '2px solid #eaeaea', color: '#4d4d4d' } : undefined} dangerouslySetInnerHTML={html} />;
      })}
    </div>
  );
}

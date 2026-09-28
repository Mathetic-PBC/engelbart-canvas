// Review (2026-09-25; design B14): what a Build changed since it started — the files, then the diff — in a dialog. For an
// accepted Build, its commit. Bare: added lines green, removed red, a file's header bold; Hudson redraws it in Claude Design.
import React from 'react';
import { createPortal } from 'react-dom';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed' };

function lineStyle(line) {
  if (line.startsWith('diff --git')) return { color: '#171717', fontWeight: 600, marginTop: 14 };
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || /^(new|deleted) file mode|^similarity index|^rename (from|to)/.test(line)) return { color: '#8f8f8f' };
  if (line.startsWith('@@')) return { color: '#0761d1' };
  if (line.startsWith('+')) return { color: '#1a7f37', background: '#f0fbf2' };
  if (line.startsWith('-')) return { color: '#cf222e', background: '#fff5f5' };
  return { color: '#4d4d4d' };
}

export default function BuildReview({ title, review, error, onClose }) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const lines = review && review.patch ? review.patch.split('\n') : [];
  return createPortal(
    <div data-overlay="1" data-build-review="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 55, display: 'flex', alignItems: 'stretch', justifyContent: 'center', padding: '6vh 24px', background: 'rgba(255,255,255,.35)' }}>
      <div role="dialog" aria-modal="true" aria-label="Review" style={{ width: 'min(980px, 100%)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '14px 18px 10px', borderBottom: '1px solid #eaeaea' }}>
          <span style={{ font: '600 15px/1.4 var(--font-sans)', color: '#171717' }}>Review</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '15px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{title}</span>
          {review && review.from && <span style={{ flex: 'none', font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>since {review.from}{review.base ? ` at ${String(review.base).slice(0, 7)}` : ''}</span>}
          <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 18px 18px' }}>
          {error && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
          {!review && !error && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Reading…</div>}
          {review && (
            <>
              <div data-review-files="1" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
                {review.files.length === 0 && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing has changed yet.</div>}
                {review.files.map((file) => (
                  <div key={`${file.status}:${file.path}`} style={{ display: 'flex', gap: 10, font: '13px/1.6 var(--font-mono)', color: '#171717' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.was ? `${file.was} → ${file.path}` : file.path}</span>
                    <span style={{ flex: 'none', color: '#8f8f8f', fontFamily: 'var(--font-sans)' }}>{STATUS[file.status] || file.status}</span>
                    <span style={{ flex: 'none', width: 90, textAlign: 'right' }}>{file.binary ? 'binary' : <><span style={{ color: '#1a7f37' }}>+{file.adds}</span> <span style={{ color: '#cf222e' }}>−{file.dels}</span></>}</span>
                  </div>
                ))}
                {review.running && <div style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Still working: this is what its last finished turn saved.</div>}
              </div>
              <pre style={{ margin: 0, font: '12.5px/1.6 var(--font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {lines.map((line, n) => <div key={n} style={lineStyle(line)}>{line || ' '}</div>)}
              </pre>
              {review.truncated && <div style={{ marginTop: 8, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>The diff is longer than this; the rest is cut.</div>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

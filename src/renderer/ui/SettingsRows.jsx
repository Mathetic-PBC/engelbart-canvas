// A settings page's groups and rows (./Settings.jsx), shared by its pages: Model's there, Connections' in
// ../workspace/Connections.jsx (MATH-64).
import React from 'react';

export const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });

// A group on a settings page: its heading, then a card of rows split by inset hairlines. The card stands out past the
// page's left edge by its own padding, so a row's words line up under the title and the heading (as Linear's do).
const PAD = 16;
const GROUP_HEAD = { display: 'flex', alignItems: 'baseline', gap: 8, margin: '28px 0 10px', ...text(14, '#171717', 500) };
const CARD = { margin: `0 -${PAD}px`, border: '1px solid #ebebeb', borderRadius: 10, background: '#fff', boxShadow: '0 1px 2px #00000008' };
const ROW = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 60, boxSizing: 'border-box', padding: `12px ${PAD}px` };
const HAIRLINE = { height: 1, margin: `0 ${PAD}px`, background: '#efefef' };

export function Group({ title, note, children, ...rest }) {
  const rows = React.Children.toArray(children);
  return (
    <section aria-label={title} {...rest}>
      <div style={GROUP_HEAD}>{title}{note}</div>
      <div style={CARD}>{rows.map((row, index) => <React.Fragment key={row.key}>{index > 0 && <div aria-hidden="true" style={HAIRLINE} />}{row}</React.Fragment>)}</div>
    </section>
  );
}

// A row's button (Reveal, Connect, Sign in…).
export const BUTTON = { height: 30, boxSizing: 'border-box', padding: '0 12px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', boxShadow: '0 1px 1px #0000000a', cursor: 'pointer', flex: 'none', ...text(13, '#171717', 500) };

/** A row: `icon` (optional) before its label and the line on what it is for, `detail` (optional) under that line, its control on the right. */
export function Row({ icon, label, hint, detail, children, ...rest }) {
  return (
    <div style={ROW} {...rest}>
      {icon && <span className="glyph-fit" style={{ flex: 'none', display: 'flex', width: 18, height: 18, marginRight: 2, color: '#4d4d4d' }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={text(13.5, '#171717', 500)}>{label}</div>
        <div style={{ marginTop: 1, ...text(12.5, '#8f8f8f') }}>{hint}</div>
        {detail}
      </div>
      {children}
    </div>
  );
}

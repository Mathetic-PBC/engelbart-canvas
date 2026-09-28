import React from 'react';

/** Port of the design system's Option (components/forms/Option.jsx): a selectable row that becomes a box when chosen.
 *  11px mark (circle = one of several, rounded square = many) filled in the accent, the label, an optional why. */
export default function Option({ on = false, many = false, label, why, onClick, boxed = true, size = 'lg', data }) {
  const [hov, setHov] = React.useState(false);
  const lg = size === 'lg';
  return (
    <div
      role={many ? 'checkbox' : 'radio'}
      aria-checked={on}
      tabIndex={0}
      data-option={data}
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (onClick) onClick(); } }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: why ? 'flex-start' : 'center', gap: 11, padding: lg ? (why ? '13px 14px' : '12px 14px') : '9px 12px', borderRadius: 8, cursor: 'pointer', outline: 'none', transition: 'border-color 120ms,background 120ms', border: '1px solid', borderColor: on ? 'var(--ink)' : boxed ? 'var(--bd)' : 'transparent', borderBottomColor: on ? 'var(--ink)' : 'var(--bd)', background: on ? 'var(--panel)' : hov ? 'var(--hov)' : 'transparent' }}
    >
      <span style={{ flex: 'none', marginTop: why ? 4 : 0, width: 11, height: 11, borderRadius: many ? 6 : '50%', border: '1.5px solid', borderColor: on ? 'var(--acc)' : 'var(--bd2)', background: on ? 'var(--acc)' : 'transparent', boxSizing: 'border-box' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: lg ? (why ? '500 13.5px/1.5 var(--font-sans)' : '13px/1.4 var(--font-sans)') : '12.5px/1.6 var(--font-sans)', color: on ? 'var(--ink)' : 'var(--mut)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: why ? 'nowrap' : 'normal' }}>{label}</span>
        {why && <span style={{ display: 'block', marginTop: 3, font: `${lg ? 12 : 11.5}px/1.6 var(--font-sans)`, color: 'var(--fnt)', textWrap: 'pretty', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{why}</span>}
      </span>
    </div>
  );
}

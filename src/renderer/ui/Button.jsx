import React from 'react';

/** Port of the design system's Button (components/actions/Button.jsx).
 *  variant: 'outline' | 'filled' (ink) | 'link' (accent text, no box); caps=true gives the tracked micro-caps pill. */
export default function Button({ variant = 'outline', size = 'lg', caps = false, disabled = false, go = false, children, onClick, style, title, type = 'button' }) {
  const [hov, setHov] = React.useState(false);
  const filled = variant === 'filled';
  const link = variant === 'link';
  const lg = size === 'lg';
  let base;
  if (caps) {
    base = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: lg ? '9px 18px' : '7px 15px', font: `500 ${lg ? 10 : 9}px/1 var(--font-sans)`, letterSpacing: lg ? '1.4px' : '1.5px', textTransform: 'uppercase', borderRadius: 999, border: '1px solid' };
  } else {
    base = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: link ? 0 : (lg ? '11px 16px' : '8px 12px'), font: `500 ${lg ? 13 : 12.5}px/1 var(--font-sans)`, borderRadius: 8, border: link ? 'none' : '1px solid' };
  }
  base = { ...base, cursor: disabled ? 'default' : 'pointer', transition: 'border-color 120ms,color 120ms,background 120ms,opacity 120ms' };
  let s;
  if (link) s = { ...base, color: disabled ? 'var(--fnt)' : (hov ? 'var(--acc-hov)' : 'var(--acc)'), background: 'none' };
  else if (disabled) s = { ...base, color: 'var(--fnt)', background: 'var(--hov)', borderColor: 'var(--bd)' };
  else if (filled) s = { ...base, color: 'var(--onacc)', background: 'var(--ink)', borderColor: 'var(--ink)', opacity: hov ? 0.86 : 1 };
  else s = { ...base, color: 'var(--ink)', background: hov ? 'var(--hov)' : 'var(--panel)', borderColor: hov ? 'var(--bd2)' : 'var(--bd)' };
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{ ...s, ...style }}>
      {children}
      {go && <span style={{ fontSize: caps ? (lg ? 12 : 10) : 14, lineHeight: 1, letterSpacing: 0 }}>›</span>}
    </button>
  );
}

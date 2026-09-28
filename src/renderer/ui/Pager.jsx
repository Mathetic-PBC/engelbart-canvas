import React from 'react';

/** Port of the design system's Pager (components/navigation/Pager.jsx): 6px dots; the current one stretches to 20px ink. */
export default function Pager({ count = 1, index = 0 }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ display: 'block', height: 6, borderRadius: 999, transition: 'width 140ms,background 140ms', width: i === index ? 20 : 6, background: i === index ? 'var(--ink)' : 'var(--bd2)' }} />
      ))}
    </span>
  );
}

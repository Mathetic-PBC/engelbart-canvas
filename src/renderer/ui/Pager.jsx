import React from 'react';

/**
 * Port of the design system's Pager (components/navigation/Pager.jsx): 6px dots; the current one stretches to 20px ink.
 * `dot`, `wide`, `off`: another size and grey (onboarding's cards, 2026-10-07: 4px dots, 16px wide, #d4d4d4).
 */
export default function Pager({ count = 1, index = 0, dot = 6, wide = 20, on = 'var(--ink)', off = 'var(--bd2)' }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ display: 'block', height: dot, borderRadius: 999, transition: 'width 140ms,background 140ms', width: i === index ? wide : dot, background: i === index ? on : off }} />
      ))}
    </span>
  );
}

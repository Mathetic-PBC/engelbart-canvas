import React from 'react';

/** Port of the design system's ThinkingDots (components/content/ThinkingDots.jsx): a 3×3 grid of pulsing dots and a label. */
export default function ThinkingDots({ label = 'generating', size = 4 }) {
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <style>{'@keyframes eng-pulse{0%,70%,100%{opacity:.15}35%{opacity:1}}'}</style>
      <span style={{ display: 'grid', gridTemplateColumns: `repeat(3,${size}px)`, gap: size > 3 ? 2.5 : 2 }}>
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} style={{ width: size, height: size, borderRadius: '50%', background: 'var(--ink)', opacity: 0.15, animation: 'eng-pulse 1.1s ease-in-out infinite', animationDelay: `${i * 90}ms` }} />
        ))}
      </span>
      <span style={{ font: `${size > 3 ? 13 : 11.5}px/1 var(--font-sans)`, letterSpacing: '0.3px', color: 'var(--fnt)' }}>{label}</span>
    </div>
  );
}

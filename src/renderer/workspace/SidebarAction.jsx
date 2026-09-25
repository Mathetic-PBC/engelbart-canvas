import React from 'react';

export default function SidebarAction({ children, className = '', ...props }) {
  return <button type="button" className={`rail-text-action ${className}`.trim()} {...props}>
    <svg className="rail-action-plus" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8" /></svg>
    <span>{children}</span>
  </button>;
}

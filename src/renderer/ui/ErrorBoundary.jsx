import React from 'react';

// A crash should read as a message, not a blank window. Errors are also kept on
// window.__errors so the CDP driver (scripts/drive.mjs errors) can print them.

export function recordError(kind, error) {
  const entry = { kind, at: new Date().toISOString(), message: error && error.message ? error.message : String(error), stack: error && error.stack ? String(error.stack) : '' };
  window.__errors = window.__errors || [];
  window.__errors.push(entry);
  return entry;
}

export default class ErrorBoundary extends React.Component {
  state = { error: null, info: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    recordError('render', error);
    this.setState({ info });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '64px 24px 24px', background: '#fff', color: '#171717', font: '13px/1.6 var(--font-sans)' }}>
        <div style={{ font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#e70022' }}>Renderer error</div>
        <div style={{ marginTop: 10, font: '500 17px/1.4 var(--font-sans)', letterSpacing: '-0.2px' }}>{error.message}</div>
        <pre style={{ marginTop: 14, padding: '12px 14px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', font: '12px/1.6 var(--font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(error.stack || '')}{info && info.componentStack ? `\n\ncomponent stack${info.componentStack}` : ''}</pre>
        <button type="button" onClick={() => window.location.reload()} style={{ marginTop: 14, padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>Reload</button>
      </div>
    );
  }
}

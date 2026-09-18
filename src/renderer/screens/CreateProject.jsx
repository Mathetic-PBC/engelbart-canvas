import React from 'react';
import Button from '../ui/Button.jsx';

// The first screen, and the + Project screen: port of design/goal-canvas "Name Project.dc.html".

const slugify = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export default function CreateProject({ onCreate, onBack, busy, error }) {
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const auto = slugify(name);
  const shownSlug = slugTouched ? slug : auto;
  const [directory, setDirectory] = React.useState('');
  const [picking, setPicking] = React.useState(false);
  const disabled = busy || !name.trim() || !directory;

  // The same native folder picker the terminal's directory chip uses.
  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const chosen = await window.terminalAPI.pickDirectory(directory || undefined);
      if (chosen) setDirectory(chosen);
    } finally {
      setPicking(false);
    }
  };

  const go = () => {
    const trimmed = name.trim();
    if (!trimmed || busy || !directory) return;
    const path = slugTouched && slug.trim() ? slugify(slug) : auto;
    onCreate({ name: trimmed, path: path || undefined, directory });
  };

  return (
    <div data-screen-label="Create a new project" style={{ position: 'absolute', inset: 0, overflow: 'auto', background: '#fff', color: '#171717', fontFamily: 'var(--font-sans)' }}>
      <div style={{ position: 'absolute', left: 24, top: 18, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        {onBack
          ? <button type="button" onClick={onBack} title="All projects" style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>
          : <span style={{ font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</span>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); go(); }} style={{ width: '100%', maxWidth: 600, margin: '0 auto', padding: '100px 24px 80px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 36, animation: 'rise 260ms cubic-bezier(.25,.1,.25,1)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <h1 style={{ margin: 0, font: '500 34px/1.2 var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' }}>Create a new project</h1>
          <p style={{ margin: 0, maxWidth: 480, font: '17px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>A project uses your papers, data, and notes as context for&nbsp;planning and building your research.</p>
        </div>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 26, padding: 32, background: '#fafafa', border: '1px solid #eaeaea', borderRadius: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="e.g. Engelbart"
              spellCheck={false}
              className="focus-bd2"
              style={{ width: '100%', padding: '14px 16px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '16px/1.4 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>Project path</span>
            <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', padding: '0 16px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, transition: 'border-color 120ms' }}>
              <span style={{ flex: 'none', font: '16px/1.4 var(--font-mono)', color: '#8f8f8f' }}>./</span>
              <input
                value={shownSlug}
                onChange={(event) => { setSlug(event.target.value); setSlugTouched(true); }}
                placeholder={auto || 'engelbart'}
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: '14px 0', border: 0, background: 'transparent', font: '16px/1.4 var(--font-mono)', color: '#171717' }}
              />
            </div>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>Code directory</span>
            <button type="button" className="hov-bd2" onClick={pick} data-pick-directory="1" title="Where this project's code lives: terminals and agents open here" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 16px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, cursor: 'pointer', textAlign: 'left', transition: 'border-color 120ms' }}>
              <span style={{ flex: 'none', font: '14px/1.4 var(--font-mono)', color: '#8f8f8f' }}>▭</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `16px/1.4 var(${directory ? '--font-mono' : '--font-sans'})`, color: directory ? '#171717' : '#8f8f8f', fontStyle: directory ? 'normal' : 'italic' }}>{directory || 'Choose the folder where code changes are made…'}</span>
              <span style={{ flex: 'none', font: '500 13px/1 var(--font-sans)', color: '#4d4d4d' }}>{directory ? 'Change' : 'Choose'}</span>
            </button>
          </div>
        </div>

        <Button variant="filled" type="submit" disabled={disabled} style={{ width: 440, maxWidth: '100%', height: 48, justifyContent: 'center', font: '500 13px/1 var(--font-sans)' }}>
          {busy ? 'Creating…' : 'Create project'}
        </Button>
        {error && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
      </form>
    </div>
  );
}

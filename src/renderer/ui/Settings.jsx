// Settings (2026-10-06, MATH-53): the gear in the top-right controls on every screen (./WindowControls.jsx), after the
// notification bell. A press opens the settings window, laid out as Linear's settings are: pages on the left (PAGES, so
// more can be added), and on the right the open page's groups, each a card of rows with a label, a line on what it is
// for, and its control. For now: Model, what Quick, Standard and Deep run on for each provider, the levels a plain
// @discover line (Standard) and its --quick / --deep take (models file → `discover`, src/main/bart/settings.cjs; each pick
// is saved as it is made, and the next run starts there, in any window, with no restart); Connections, the app's accounts
// (../workspace/Connections.jsx; MATH-64, it was its own icon beside the bell until then); and in test mode Test data,
// the actions that were test mode's own gear (./TestToggle.jsx keeps the pill). A search field tops the column and
// narrows it to the pages whose title or keywords hold the query (2026-10-07).
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { shownProviders, defaultProvider, defaultStep, patchOf } from '../model/intelligence.js';
import { ConnectionsPage, TOOL_CONNECTIONS, TOOL_NAME } from '../workspace/Connections.jsx';
import { Group, Row, BUTTON, text } from './SettingsRows.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

// The gear: Lucide's "settings", drawn as the bell beside it is (17px, a 2px stroke), in a button like the bell's (styles.css .settings-gear).
const GEAR = (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

// The three levels, in order, with what each is for.
export const LEVELS = Object.freeze([
  { id: 'quick', name: 'Quick', hint: 'Used by @discover --quick' },
  { id: 'standard', name: 'Standard', hint: 'Used by a plain @discover line' },
  { id: 'deep', name: 'Deep', hint: 'Used by @discover --deep' },
]);

const SELECT = { height: 30, boxSizing: 'border-box', padding: '0 26px 0 10px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', boxShadow: '0 1px 1px #0000000a', appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', ...text(13), outline: 'none' };

/** A compact select with the app's chevron. `options`: [{ value, label }]; `width` lines a column of them up. */
function Choice({ label, value, options, onChange, disabled, field, width }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block', flex: 'none' }}>
      <select aria-label={label} data-level-field={field} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="hov-bd2" style={{ ...SELECT, width, opacity: disabled ? 0.45 : 1 }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#8f8f8f" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: 8, top: '50%', marginTop: -5, pointerEvents: 'none' }}><path d="M2.5 4 5 6.5 7.5 4" /></svg>
    </span>
  );
}

/**
 * Model: per provider offered, a group of the three levels, each a model and an effort. A provider whose CLI cannot
 * run says so under its heading; its levels can still be set. `initial`: what api.settingsModels() gave, when it is already
 * known (the tests' static render).
 */
export function IntelligenceLevels({ initial = null }) {
  const [settings, setSettings] = React.useState(initial);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let live = true;
    const load = () => api.settingsModels().then((value) => { if (live) setSettings(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    load();
    // Another window saved.
    const off = api.onModelsChanged ? api.onModelsChanged(load) : () => {};
    return () => { live = false; off(); };
  }, []);
  if (!settings) return <div style={{ padding: '8px 0', ...text(13, error ? 'var(--red-600)' : '#8f8f8f') }}>{error || 'Loading…'}</div>;
  // The provider @discover runs on first.
  const home = defaultProvider(settings, 'bart');
  const providers = shownProviders(settings).sort((x, y) => (x === home ? -1 : y === home ? 1 : 0));
  const save = (provider, level, step) => api.saveSettingsModels(patchOf('discover', provider, step, level)).then((value) => { setSettings(value); setError(''); }, (e) => setError(errorMessage(e)));
  return (
    <div data-intelligence-levels="1">
      {settings.fileError && <div role="alert" data-models-file-error="1" style={{ marginTop: 16, padding: '8px 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', ...text(12.5, 'var(--red-600)') }}>{settings.fileError}</div>}
      {providers.map((provider) => {
        const entry = settings.models.providers[provider], note = settings.cli[provider];
        const models = Object.keys(entry.models).map((key) => ({ value: key, label: entry.models[key].name }));
        const efforts = entry.efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] || effort }));
        return (
          <Group key={provider} title={entry.name} data-levels-provider={provider} note={note && <span data-cli-note={provider} style={text(12.5, '#8f8f8f')}>{note}</span>}>
            {LEVELS.map((level) => {
              const step = defaultStep(settings.models, 'discover', provider, level.id);
              return (
                <Row key={level.id} label={level.name} hint={level.hint} data-level={`${provider}:${level.id}`}>
                  <Choice label={`${entry.name} ${level.name} model`} field="model" width={96} value={step.model} options={models} onChange={(model) => save(provider, level.id, { model, effort: step.effort })} />
                  <Choice label={`${entry.name} ${level.name} effort`} field="effort" width={110} value={step.effort} options={efforts} onChange={(effort) => save(provider, level.id, { model: step.model, effort })} />
                </Row>
              );
            })}
          </Group>
        );
      })}
      {error && <div role="alert" style={{ marginTop: 10, ...text(12.5, 'var(--red-600)') }}>{error}</div>}
    </div>
  );
}

/** Test data (test mode only): the test library's folder, and starting it over. `close` shuts the window first where the app starts again. */
function TestData({ test, close }) {
  const act = (run, shut) => () => { if (shut) close(); run(); };
  return (
    <Group title="Test library" data-test-data="1">
      <Row key="reveal" label="Reveal in Finder" hint="Open ~/.engelbart/test, where test mode keeps everything">
        <button type="button" className="hov-bd2" data-settings-item="reveal" onClick={act(test.onReveal)} style={BUTTON}>Reveal</button>
      </Row>
      <Row key="start-new" label="Start as a new user" hint="An empty library and onboarding from its first screen">
        <button type="button" className="hov-bd2" data-settings-item="start-new" onClick={act(test.onStartNew, true)} style={BUTTON}>Start over…</button>
      </Row>
      <Row key="reset" label="Reset everything" hint="Delete the test library and seed it again">
        <button type="button" className="hov-bd2" data-settings-item="reset" onClick={act(test.onReset, true)} style={{ ...BUTTON, color: '#e70022' }}>Reset…</button>
      </Row>
    </Group>
  );
}

// Lucide's "sparkles" (the intelligence a model brings, as Linear and others draw AI) and "flask-conical", at the nav's
// size; the plug Connections' own icon was (its 16-unit path at this grid's scale). Lucide is ISC; its paths are pasted in.
const icon = (paths) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block' }}>{paths}</svg>
);
const MODEL_ICON = icon(<><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" /></>);
const PLUG_ICON = icon(<path d="M8.25 2.25v4.5M15.75 2.25v4.5M6 6.75h12v3a6 6 0 0 1-12 0zM12 15.75v3a3 3 0 0 1-3 3H6" />);
const FLASK_ICON = icon(<><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" /><path d="M8.5 2h7" /><path d="M7 16h10" /></>);

// The settings window's pages, in order, under their headings in the left column. `shown` (optional) decides from the
// window's props whether a page is there. `keywords`: the names on the page a person would search the column for.
export const PAGES = Object.freeze([
  { id: 'model', section: 'Settings', title: 'Model', icon: MODEL_ICON, Body: () => <IntelligenceLevels />,
    keywords: [...LEVELS.flatMap((level) => [level.name, level.hint]), 'model', 'effort', 'intelligence', 'discover', 'Claude', 'Codex'] },
  { id: 'connections', section: 'Settings', title: 'Connections', icon: PLUG_ICON, Body: ConnectionsPage,
    keywords: ['GitHub', 'Zotero', 'accounts', 'sign in', 'sign out', ...TOOL_CONNECTIONS.map((id) => TOOL_NAME[id])] },
  { id: 'test-data', section: 'Developer', title: 'Test data', icon: FLASK_ICON, shown: ({ test }) => !!(test && test.testMode), Body: TestData,
    keywords: ['reveal', 'reset', 'start over', 'test library'] },
]);

/** Whether a page answers a search: case-insensitive, its title or a keyword holding the trimmed query. An empty one, every page. */
export function pageMatches(page, query) {
  const want = String(query || '').trim().toLowerCase();
  return !want || [page.title, ...(page.keywords || [])].some((name) => name.toLowerCase().includes(want));
}

/** Escape pressed in an open menu on a page (Connections' "…": Sign out, Disconnect) is that menu's: it closes the menu, and the next one the window. */
export const menuHasEscape = (target) => !!(target && target.closest && target.closest('[role="menu"]'));

/** What Escape does where it was pressed: 'menu' (an open "…" menu takes it), 'clear' (the search field holds text), or 'close' the window. */
export function escapeAction(target) {
  if (menuHasEscape(target)) return 'menu';
  if (target && target.matches && target.matches('[data-settings-search]') && target.value) return 'clear';
  return 'close';
}

const NAV_ITEM = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', height: 30, boxSizing: 'border-box', padding: '0 9px', border: 0, borderRadius: 6, cursor: 'pointer', textAlign: 'left' };
const SEARCH = { width: '100%', height: 30, boxSizing: 'border-box', padding: '0 9px 0 30px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', ...text(13), outline: 'none' };
// Lucide's "search", 14px.
const SEARCH_ICON = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', marginTop: -7, pointerEvents: 'none' }}><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></svg>
);

/**
 * The left column: the search field, then the pages that answer it under their headings (a heading only over a page
 * listed). `pages`: those shown; `open`: the open page's id, which stays open on the right when the search hides it.
 * Enter in the field opens the first page listed.
 */
export function SettingsNav({ pages, open, query, onQuery, onOpen }) {
  const listed = pages.filter((page) => pageMatches(page, query));
  const sections = [];
  for (const page of listed) {
    const last = sections[sections.length - 1];
    if (last && last.title === page.section) last.pages.push(page); else sections.push({ title: page.section, pages: [page] });
  }
  return (
    <nav aria-label="Settings pages" style={{ flex: 'none', width: 200, boxSizing: 'border-box', padding: '16px 10px', borderRight: '1px solid #ebebeb', background: '#f5f5f5', overflowY: 'auto' }}>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        {SEARCH_ICON}
        <input type="text" aria-label="Search settings" data-settings-search="1" placeholder="Search…" value={query} spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && listed.length) { event.preventDefault(); onOpen(listed[0].id); } }}
          style={SEARCH} />
      </div>
      {!listed.length && <div data-settings-no-results="1" style={{ padding: '0 9px', ...text(13, '#8f8f8f') }}>No results</div>}
      {sections.map((section, index) => (
        <React.Fragment key={section.title}>
          <div style={{ padding: '0 9px', margin: index ? '16px 0 4px' : '0 0 4px', ...text(12.5, '#8f8f8f', 500) }}>{section.title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {section.pages.map((candidate) => {
              const on = candidate.id === open;
              return (
                <button key={candidate.id} type="button" data-settings-page={candidate.id} aria-current={on ? 'page' : undefined} onClick={() => onOpen(candidate.id)} className={on ? undefined : 'hov-wash2'}
                  style={{ ...NAV_ITEM, background: on ? '#e8e8e8' : 'transparent', ...text(13.5, '#171717', on ? 500 : 400) }}>
                  <span style={{ color: on ? '#171717' : '#6f6f6f' }}>{candidate.icon}</span>{candidate.title}
                </button>
              );
            })}
          </div>
        </React.Fragment>
      ))}
    </nav>
  );
}

/**
 * The settings window: pages listed on the left, the open one on the right; Escape, × or a press outside closes it.
 * Escape in the search field while it holds text clears the text instead.
 */
function SettingsDialog({ test, onClose }) {
  const pages = PAGES.filter((page) => !page.shown || page.shown({ test }));
  const [page, setPage] = React.useState(pages[0].id);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    // Taken before the workspace's own Escape (which leaves the workspace) can see it, as BuildReject does.
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      const action = escapeAction(event.target);
      if (action === 'menu') return;
      event.preventDefault(); event.stopPropagation();
      if (action === 'clear') setQuery(''); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const open = pages.find((candidate) => candidate.id === page) || pages[0];
  const Body = open.Body;
  return createPortal(
    <div data-overlay="1" data-levels-dialog="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" style={{ position: 'relative', display: 'flex', width: 'min(780px, calc(100vw - 32px))', height: 'min(540px, calc(100vh - 80px))', background: '#fcfcfc', border: '1px solid #d4d4d4', borderRadius: 12, boxShadow: '0 16px 48px #00000024', overflow: 'hidden', animation: `rise 160ms ${EASE}` }}>
        <SettingsNav pages={pages} open={open.id} query={query} onQuery={setQuery} onOpen={setPage} />
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '30px 40px 36px', boxSizing: 'border-box' }}>
          <div style={{ ...text(22, '#171717', 500), letterSpacing: '-0.01em' }}>{open.title}</div>
          <Body test={test} close={onClose} />
        </div>
        <button type="button" className="hov-ink" aria-label="Close" onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', ...text(18, '#8f8f8f'), lineHeight: 1 }}>×</button>
      </div>
    </div>,
    document.body,
  );
}

/** `test` (a developer's copy only, else null): { testMode, onReveal, onStartNew, onReset }, for the Test data page. */
export default function Settings({ test = null }) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <div data-settings="1" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button type="button" className="settings-gear" title="Settings" aria-label="Settings" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {GEAR}
      </button>
      {open && <SettingsDialog test={test} onClose={close} />}
    </div>
  );
}

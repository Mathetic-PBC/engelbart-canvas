// Settings (2026-10-06, MATH-53): the gear in the top-right controls on every screen (./WindowControls.jsx), after the
// notification bell. A press opens a small menu (it closes on a press outside it and on Escape) whose items are a list
// (MENU), so more can be added: for now "Intelligence levels…", and in test mode the Test data actions that were test
// mode's own gear until today (./TestToggle.jsx keeps the pill).
// "Intelligence levels…" opens the settings window (laid out as Linear's preferences are: pages on the left, groups of rows
// on the right) at Intelligence: what Quick, Standard and Deep run on for each provider, the levels a plain @discover line
// (Standard) and its --quick / --deep take (models file → `discover`, src/main/bart/settings.cjs). Each pick is saved as
// it is made: the next run starts there, in any window, with no restart.
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { shownProviders, defaultProvider, defaultStep, patchOf } from '../model/intelligence.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });

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

const SELECT = { height: 28, boxSizing: 'border-box', padding: '0 24px 0 9px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', ...text(12.5), outline: 'none' };

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

// A group on a settings page: its heading, then a card of rows split by hairlines (as Linear's preferences are drawn).
const GROUP_HEAD = { margin: '18px 0 8px', ...text(13, '#171717', 500) };
const CARD = { border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', overflow: 'hidden' };
const ROW = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px' };

/**
 * Intelligence: per provider offered, a group of the three levels, each a model and an effort. A provider whose CLI cannot
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
      {settings.fileError && <div role="alert" data-models-file-error="1" style={{ marginTop: 12, padding: '8px 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', ...text(12.5, 'var(--red-600)') }}>{settings.fileError}</div>}
      {providers.map((provider) => {
        const entry = settings.models.providers[provider], note = settings.cli[provider];
        const models = Object.keys(entry.models).map((key) => ({ value: key, label: entry.models[key].name }));
        const efforts = entry.efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] || effort }));
        return (
          <section key={provider} data-levels-provider={provider} aria-label={entry.name}>
            <div style={GROUP_HEAD}>
              {entry.name}
              {note && <span data-cli-note={provider} style={{ marginLeft: 8, ...text(12, '#8f8f8f') }}>{note}</span>}
            </div>
            <div style={CARD}>
              {LEVELS.map((level, index) => {
                const step = defaultStep(settings.models, 'discover', provider, level.id);
                return (
                  <div key={level.id} data-level={`${provider}:${level.id}`} style={{ ...ROW, borderTop: index ? '1px solid #eaeaea' : 0 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={text(13, '#171717', 500)}>{level.name}</div>
                      <div style={text(12, '#8f8f8f')}>{level.hint}</div>
                    </div>
                    <Choice label={`${entry.name} ${level.name} model`} field="model" width={92} value={step.model} options={models} onChange={(model) => save(provider, level.id, { model, effort: step.effort })} />
                    <Choice label={`${entry.name} ${level.name} effort`} field="effort" width={104} value={step.effort} options={efforts} onChange={(effort) => save(provider, level.id, { model: step.model, effort })} />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {error && <div role="alert" style={{ marginTop: 10, ...text(12.5, 'var(--red-600)') }}>{error}</div>}
    </div>
  );
}

// The settings window's pages, in its left column. One for now; more are added here.
export const PAGES = Object.freeze([
  { id: 'intelligence', title: 'Intelligence', lead: 'What each level runs on, for each provider. Changes are saved as you make them.', Body: IntelligenceLevels },
]);

const NAV_ICON = (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block' }}>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 15l.8 1.9 1.9.8-1.9.8L19 20.5l-.8-1.9-1.9-.8 1.9-.8z" />
  </svg>
);

/** The settings window: pages listed on the left, the open one on the right; Escape, × or a press outside closes it. */
function SettingsDialog({ page: first = 'intelligence', onClose }) {
  const [page, setPage] = React.useState(first);
  React.useEffect(() => {
    // Taken before the workspace's own Escape (which leaves the workspace) can see it, as BuildReject does.
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const open = PAGES.find((candidate) => candidate.id === page) || PAGES[0];
  const Body = open.Body;
  return createPortal(
    <div data-overlay="1" data-levels-dialog="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" style={{ display: 'flex', width: 'min(680px, calc(100vw - 32px))', height: 'min(460px, calc(100vh - 80px))', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', overflow: 'hidden', animation: `rise 160ms ${EASE}` }}>
        <nav aria-label="Settings pages" style={{ flex: 'none', width: 176, boxSizing: 'border-box', padding: '14px 8px', borderRight: '1px solid #eaeaea', background: '#fafafa' }}>
          <div style={{ padding: '0 8px 8px', ...text(12, '#8f8f8f', 500) }}>Settings</div>
          {PAGES.map((candidate) => {
            const on = candidate.id === open.id;
            return (
              <button key={candidate.id} type="button" data-settings-page={candidate.id} aria-current={on ? 'page' : undefined} onClick={() => setPage(candidate.id)} className={on ? undefined : 'hov-wash2'}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: 0, borderRadius: 6, background: on ? '#eaeaea' : 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13, '#171717', on ? 500 : 400) }}>
                {NAV_ICON}{candidate.title}
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 24px 24px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={text(17, '#171717', 500)}>{open.title}</div>
              <div style={{ marginTop: 2, ...text(12.5, '#8f8f8f') }}>{open.lead}</div>
            </div>
            <button type="button" className="hov-ink" aria-label="Close" onClick={onClose} style={{ flex: 'none', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', ...text(18, '#8f8f8f'), lineHeight: 1 }}>×</button>
          </div>
          <Body />
        </div>
      </div>
    </div>,
    document.body,
  );
}

const ITEM = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', ...text(13) };

// The menu's items, in order. `shown` (optional) decides from the menu's props whether an item is there; `danger` reds it.
export const MENU = Object.freeze([
  { id: 'levels', label: 'Intelligence levels…', act: ({ openLevels }) => openLevels() },
  { id: 'reveal', label: 'Reveal test data in Finder', shown: ({ test }) => !!(test && test.testMode), act: ({ test }) => test.onReveal() },
  { id: 'start-new', label: 'Start as a new user…', shown: ({ test }) => !!(test && test.testMode), act: ({ test }) => test.onStartNew() },
  { id: 'reset', label: 'Reset everything…', danger: true, shown: ({ test }) => !!(test && test.testMode), act: ({ test }) => test.onReset() },
]);

/** `test` (a developer's copy only, else null): { testMode, onReveal, onStartNew, onReset }, for the test data items. */
export default function Settings({ test = null }) {
  const [open, setOpen] = React.useState(false);
  const [levels, setLevels] = React.useState(false);
  const ref = React.useRef(null);
  const closeLevels = React.useCallback(() => setLevels(false), []);
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!ref.current || !ref.current.contains(event.target)) setOpen(false); };
    // On the document, as Connections' is: it hears the key before the window does, where the workspace's Escape (leave
    // the full screen, close the workspace) waits and passes over a key already used.
    const key = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key); };
  }, [open]);
  const items = MENU.filter((item) => !item.shown || item.shown({ test }));
  const props = { test, openLevels: () => setLevels(true) };
  return (
    <div ref={ref} data-settings="1" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button type="button" className="settings-gear" title="Settings" aria-label="Settings" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        {GEAR}
      </button>
      {open && (
        <div data-overlay="1" data-settings-menu="1" role="menu" aria-label="Settings"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', minWidth: 210, boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
          {items.map((item, index) => (
            <React.Fragment key={item.id}>
              {index === 1 && <div role="separator" style={{ margin: '4px 6px', borderTop: '1px solid #eaeaea' }} />}
              <button type="button" role="menuitem" className="hov-wash" data-settings-item={item.id} onClick={() => { setOpen(false); item.act(props); }} style={{ ...ITEM, color: item.danger ? '#e70022' : '#171717' }}>{item.label}</button>
            </React.Fragment>
          ))}
        </div>
      )}
      {levels && <SettingsDialog onClose={closeLevels} />}
    </div>
  );
}

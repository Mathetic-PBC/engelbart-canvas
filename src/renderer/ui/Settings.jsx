// Settings (2026-10-06, MATH-53): the gear in the top-right controls on every screen (./WindowControls.jsx), after the
// notification bell. A press opens a small menu (it closes on a press outside it and on Escape) whose items are a list
// (MENU), so more can be added: for now "Intelligence levels…", and in test mode the Test data actions that were test
// mode's own gear until today (./TestToggle.jsx keeps the pill).
// Intelligence levels (2026-10-06): a dialog setting what Quick, Standard and Deep run on for each provider, the levels a
// plain @discover line (Standard) and its --quick / --deep take (models file → `discover`, src/main/bart/settings.cjs).
// Each pick is saved as it is made: the next run starts there, in any window, with no restart.
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
  { id: 'quick', name: 'Quick', hint: '--quick' },
  { id: 'standard', name: 'Standard', hint: 'A plain line' },
  { id: 'deep', name: 'Deep', hint: '--deep' },
]);

const SELECT = { width: '100%', height: 30, boxSizing: 'border-box', padding: '0 26px 0 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', ...text(13), outline: 'none' };

/** A plain select with the app's caret. `options`: [{ value, label }]. */
function Choice({ label, value, options, onChange, disabled, field }) {
  return (
    <span style={{ position: 'relative', display: 'block', minWidth: 0 }}>
      <select aria-label={label} data-level-field={field} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="hov-bd2" style={{ ...SELECT, opacity: disabled ? 0.45 : 1 }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#8f8f8f" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', right: 10, top: '50%', marginTop: -5, pointerEvents: 'none' }}><path d="M2.5 4 5 6.5 7.5 4" /></svg>
    </span>
  );
}

/**
 * The levels of one provider at a time: a provider switch when more than one is offered (starting on the one @discover
 * runs on), then a row per level with its model and its effort. `initial`: what api.settingsModels() gave, when it is
 * already known (the tests' static render).
 */
export function IntelligenceLevels({ initial = null }) {
  const [settings, setSettings] = React.useState(initial);
  const [error, setError] = React.useState('');
  const [viewed, setViewed] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    const load = () => api.settingsModels().then((value) => { if (live) setSettings(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    load();
    // Another window saved.
    const off = api.onModelsChanged ? api.onModelsChanged(load) : () => {};
    return () => { live = false; off(); };
  }, []);
  if (!settings) return <div style={{ padding: '8px 0', ...text(13, error ? 'var(--red-600)' : '#8f8f8f') }}>{error || 'Loading…'}</div>;
  const providers = shownProviders(settings);
  const provider = providers.includes(viewed) ? viewed : providers.includes(defaultProvider(settings, 'bart')) ? defaultProvider(settings, 'bart') : providers[0];
  const entry = settings.models.providers[provider];
  const note = settings.cli[provider];
  const save = (level, step) => api.saveSettingsModels(patchOf('discover', provider, step, level)).then((value) => { setSettings(value); setError(''); }, (e) => setError(errorMessage(e)));
  const models = Object.keys(entry.models).map((key) => ({ value: key, label: entry.models[key].name }));
  const efforts = entry.efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] || effort }));
  return (
    <div data-intelligence-levels="1">
      {settings.fileError && <div role="alert" data-models-file-error="1" style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', ...text(12.5, 'var(--red-600)') }}>{settings.fileError}</div>}
      {providers.length > 1 && (
        <div role="tablist" aria-label="Provider" data-levels-provider="1" style={{ display: 'inline-flex', marginBottom: 14, padding: 2, border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa' }}>
          {providers.map((id) => {
            const on = id === provider;
            return (
              <button key={id} type="button" role="tab" aria-selected={on} data-provider={id} onClick={() => setViewed(id)}
                style={{ padding: '5px 12px', border: 0, borderRadius: 6, background: on ? '#fff' : 'transparent', boxShadow: on ? '0 0 0 1px #eaeaea' : 'none', cursor: on ? 'default' : 'pointer', ...text(12.5, on ? '#171717' : '#8f8f8f', on ? 500 : 400), transition: 'background 120ms, color 120ms' }}>
                {settings.models.providers[id].name}
              </button>
            );
          })}
        </div>
      )}
      {note && <div data-cli-note={provider} style={{ margin: '-6px 0 10px', ...text(12, '#8f8f8f') }}>{entry.name} is {note}: these are saved, and used once it can run.</div>}
      <div role="table" aria-label={`${entry.name} levels`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {LEVELS.map((level) => {
          const step = defaultStep(settings.models, 'discover', provider, level.id);
          return (
            <div key={level.id} role="row" data-level={`${provider}:${level.id}`} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr) minmax(0, 0.8fr)', columnGap: 8, alignItems: 'center' }}>
              <span role="rowheader" style={{ minWidth: 0 }}>
                <span style={{ display: 'block', ...text(13, '#171717', 500) }}>{level.name}</span>
                <span style={{ display: 'block', ...text(11.5, '#8f8f8f') }}>{level.hint}</span>
              </span>
              <Choice label={`${level.name} model`} field="model" value={step.model} options={models} onChange={(model) => save(level.id, { model, effort: step.effort })} />
              <Choice label={`${level.name} effort`} field="effort" value={step.effort} options={efforts} onChange={(effort) => save(level.id, { model: step.model, effort })} />
            </div>
          );
        })}
      </div>
      {error && <div role="alert" style={{ marginTop: 10, ...text(12.5, 'var(--red-600)') }}>{error}</div>}
    </div>
  );
}

/** The dialog the menu's "Intelligence levels…" opens: centred over a dimmed window; Escape, × or a press outside closes it. */
function LevelsDialog({ onClose }) {
  React.useEffect(() => {
    // Taken before the workspace's own Escape (which leaves the workspace) can see it, as BuildReject does.
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div data-overlay="1" data-levels-dialog="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-label="Intelligence levels" style={{ width: 'min(480px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 80px)', overflowY: 'auto', boxSizing: 'border-box', padding: '18px 20px 20px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={text(15, '#171717', 500)}>Intelligence levels</div>
            <div style={{ marginTop: 2, ...text(12.5, '#8f8f8f') }}>What each level runs on. A plain @discover line runs Standard; --quick and --deep pick the others.</div>
          </div>
          <button type="button" className="hov-ink" aria-label="Close" onClick={onClose} style={{ flex: 'none', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', ...text(18, '#8f8f8f'), lineHeight: 1 }}>×</button>
        </div>
        <IntelligenceLevels />
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
      {levels && <LevelsDialog onClose={closeLevels} />}
    </div>
  );
}

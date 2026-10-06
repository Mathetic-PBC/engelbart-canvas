// Settings (2026-10-06, MATH-53): the gear in the top-right controls on every screen (./WindowControls.jsx), after the
// notification bell. A press opens the settings window, laid out as Linear's settings are: pages on the left (PAGES, so
// more can be added), and on the right the open page's groups, each a card of rows with a label, a line on what it is
// for, and its control. For now: Model, what Quick, Standard and Deep run on for each provider, the levels a plain
// @discover line (Standard) and its --quick / --deep take (models file → `discover`, src/main/bart/settings.cjs; each pick
// is saved as it is made, and the next run starts there, in any window, with no restart); and in test mode Test data,
// the actions that were test mode's own gear (./TestToggle.jsx keeps the pill).
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

// A group on a settings page: its heading, then a card of rows split by inset hairlines. The card stands out past the
// page's left edge by its own padding, so a row's words line up under the title and the heading (as Linear's do).
const PAD = 16;
const GROUP_HEAD = { display: 'flex', alignItems: 'baseline', gap: 8, margin: '28px 0 10px', ...text(14, '#171717', 500) };
const CARD = { margin: `0 -${PAD}px`, border: '1px solid #ebebeb', borderRadius: 10, background: '#fff', boxShadow: '0 1px 2px #00000008' };
const ROW = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 60, boxSizing: 'border-box', padding: `12px ${PAD}px` };
const HAIRLINE = { height: 1, margin: `0 ${PAD}px`, background: '#efefef' };

function Group({ title, note, children, ...rest }) {
  const rows = React.Children.toArray(children);
  return (
    <section aria-label={title} {...rest}>
      <div style={GROUP_HEAD}>{title}{note}</div>
      <div style={CARD}>{rows.map((row, index) => <React.Fragment key={row.key}>{index > 0 && <div aria-hidden="true" style={HAIRLINE} />}{row}</React.Fragment>)}</div>
    </section>
  );
}

function Row({ label, hint, children, ...rest }) {
  return (
    <div style={ROW} {...rest}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={text(13.5, '#171717', 500)}>{label}</div>
        <div style={{ marginTop: 1, ...text(12.5, '#8f8f8f') }}>{hint}</div>
      </div>
      {children}
    </div>
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

const BUTTON = { height: 30, boxSizing: 'border-box', padding: '0 12px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', boxShadow: '0 1px 1px #0000000a', cursor: 'pointer', flex: 'none', ...text(13, '#171717', 500) };

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

// Lucide's "box" (a model, as model hubs draw one) and "flask-conical", at the nav's size.
const icon = (paths) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block' }}>{paths}</svg>
);
const MODEL_ICON = icon(<><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>);
const FLASK_ICON = icon(<><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" /><path d="M8.5 2h7" /><path d="M7 16h10" /></>);

// The settings window's pages, in order, under their headings in the left column. `shown` (optional) decides from the
// window's props whether a page is there.
export const PAGES = Object.freeze([
  { id: 'model', section: 'Settings', title: 'Model', icon: MODEL_ICON, Body: () => <IntelligenceLevels /> },
  { id: 'test-data', section: 'Developer', title: 'Test data', icon: FLASK_ICON, shown: ({ test }) => !!(test && test.testMode), Body: TestData },
]);

const NAV_ITEM = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', height: 30, boxSizing: 'border-box', padding: '0 9px', border: 0, borderRadius: 6, cursor: 'pointer', textAlign: 'left' };

/** The settings window: pages listed on the left, the open one on the right; Escape, × or a press outside closes it. */
function SettingsDialog({ test, onClose }) {
  const pages = PAGES.filter((page) => !page.shown || page.shown({ test }));
  const [page, setPage] = React.useState(pages[0].id);
  React.useEffect(() => {
    // Taken before the workspace's own Escape (which leaves the workspace) can see it, as BuildReject does.
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const open = pages.find((candidate) => candidate.id === page) || pages[0];
  const Body = open.Body;
  return createPortal(
    <div data-overlay="1" data-levels-dialog="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" style={{ position: 'relative', display: 'flex', width: 'min(780px, calc(100vw - 32px))', height: 'min(540px, calc(100vh - 80px))', background: '#fcfcfc', border: '1px solid #d4d4d4', borderRadius: 12, boxShadow: '0 16px 48px #00000024', overflow: 'hidden', animation: `rise 160ms ${EASE}` }}>
        <nav aria-label="Settings pages" style={{ flex: 'none', width: 200, boxSizing: 'border-box', padding: '16px 10px', borderRight: '1px solid #ebebeb', background: '#f5f5f5' }}>
          {pages.map((candidate, index) => {
            const on = candidate.id === open.id;
            return (
              <React.Fragment key={candidate.id}>
                {(index === 0 || pages[index - 1].section !== candidate.section) && <div style={{ padding: '0 9px', margin: index ? '16px 0 4px' : '0 0 4px', ...text(12.5, '#8f8f8f', 500) }}>{candidate.section}</div>}
                <button type="button" data-settings-page={candidate.id} aria-current={on ? 'page' : undefined} onClick={() => setPage(candidate.id)} className={on ? undefined : 'hov-wash2'}
                  style={{ ...NAV_ITEM, background: on ? '#e8e8e8' : 'transparent', ...text(13.5, '#171717', on ? 500 : 400) }}>
                  <span style={{ color: on ? '#171717' : '#6f6f6f' }}>{candidate.icon}</span>{candidate.title}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
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

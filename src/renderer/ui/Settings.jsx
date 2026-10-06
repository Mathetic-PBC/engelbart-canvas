// Settings (2026-10-06, MATH-53): the ⚙ in the top-right controls on every screen (./WindowControls.jsx), after the
// notification bell, and the panel it opens under it, styled as test mode's menu was (it closes on a press outside it and
// on Escape). Its sections are a list (SECTIONS), so more can be added: Intelligence first, the default model and effort
// of each agent on each provider (src/main/bart/settings.cjs); then, in test mode only, Test data, which was the menu of
// test mode's own gear until today (./TestToggle.jsx keeps the pill).
import React from 'react';
import { api, errorMessage } from '../api.js';
import ModelGrid, { Caret, EASE } from '../post-its/ModelGrid.jsx';
import { AGENT_ROWS, ADVANCED_LEVELS, shownProviders, defaultProvider, defaultStep, cellModels, patchOf, stepLabel, lastPick } from '../model/intelligence.js';

const HEAD = { padding: '6px 10px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' };
const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const LINK = { padding: 0, border: 0, background: 'transparent', cursor: 'pointer', ...text(12, 'var(--acc)', 500) };
const LABEL_WIDTH = 104;

/** A choice of one provider among those offered (Claude Code, Codex); one alone is named, not offered. */
function ProviderChoice({ label, providers, names, value, onPick, field }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px' }}>
      <span style={{ flex: 1, minWidth: 0, ...text(12.5, '#4d4d4d') }}>{label}</span>
      <div role="radiogroup" aria-label={label} data-settings-provider={field} style={{ flex: 'none', display: 'flex', padding: 2, border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa' }}>
        {providers.map((id) => {
          const on = id === value;
          return (
            <button key={id} type="button" role="radio" aria-checked={on} data-provider={id} disabled={providers.length < 2} onClick={() => { if (!on) onPick(id); }}
              style={{ padding: '4px 10px', border: 0, borderRadius: 6, background: on ? '#fff' : 'transparent', boxShadow: on ? '0 0 0 1px #eaeaea' : 'none', cursor: on || providers.length < 2 ? 'default' : 'pointer', ...text(12, on ? '#171717' : '#8f8f8f', on ? 500 : 400), transition: 'background 120ms, color 120ms' }}>
              {names[id]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One agent's default on one provider: what it starts on, greyed while that provider's CLI cannot run. A press opens its grid under the row. */
function Cell({ settings, agent, provider, level, open, onToggle, home }) {
  const list = cellModels(settings.models, agent, provider).providers[provider];
  const note = settings.cli[provider];
  return (
    <button type="button" data-settings-cell={`${agent}:${provider}:${level}`} aria-expanded={open} aria-haspopup="dialog" onClick={onToggle}
      title={note ? `${list.name}: ${note}` : home ? `Runs on ${list.name} unless picked by hand` : `On ${list.name}`}
      style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 6px 0 10px', border: `1px solid ${open ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 8, background: open ? '#fff' : '#fafafa', cursor: 'pointer', opacity: note ? 0.45 : 1, textAlign: 'left', transition: 'border-color 120ms, background 120ms' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12.5, home ? '#171717' : '#4d4d4d', home ? 500 : 400) }}>{stepLabel(list, defaultStep(settings.models, agent, provider, level))}</span>
      <Caret up={open} />
    </button>
  );
}

/** A row of cells: the agent (or @discover's level) on the left, one cell per provider shown. */
function Row({ settings, providers, label, agent, level = 'standard', home, editing, onEdit, onSave, indent = false }) {
  const columns = { display: 'grid', gridTemplateColumns: `${LABEL_WIDTH}px repeat(${providers.length}, minmax(0, 1fr))`, columnGap: 6, alignItems: 'center', padding: '3px 10px' };
  const open = editing && editing.agent === agent && editing.level === level ? editing.provider : null;
  return (
    <>
      <div style={columns} data-settings-row={level === 'standard' ? agent : `${agent}:${level}`}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: indent ? 12 : 0, ...text(indent ? 12 : 13, indent ? '#4d4d4d' : '#171717', indent ? 400 : 500) }}>{label}</span>
        {providers.map((provider) => (
          <Cell key={provider} settings={settings} agent={agent} provider={provider} level={level} home={provider === home} open={open === provider}
            onToggle={() => onEdit(open === provider ? null : { agent, provider, level })} />
        ))}
      </div>
      {open && (
        <div data-settings-grid={`${agent}:${open}:${level}`} style={{ margin: '4px 10px 8px', border: '1px solid #eaeaea', borderRadius: 10, overflow: 'hidden', background: '#fff', animation: `rise 120ms ${EASE}` }}>
          <ModelGrid models={cellModels(settings.models, agent, open)} choice={{ provider: open, ...defaultStep(settings.models, agent, open, level) }} onChoose={(next) => onSave(patchOf(agent, open, next, level))} />
        </div>
      )}
    </>
  );
}

/** "Using your last pick: Opus High · Use default" under a row whose place starts on a pick by hand instead of its default. */
function LastPick({ settings, place, lead, onForget }) {
  const pick = lastPick(settings, place);
  if (!pick) return null;
  return (
    <div data-last-pick={place} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: `0 10px 4px ${LABEL_WIDTH + 16}px`, ...text(12, '#8f8f8f') }}>
      <span style={{ minWidth: 0 }}>{lead}: <span style={{ color: '#4d4d4d' }}>{pick.label}</span></span>
      <span aria-hidden="true">·</span>
      <button type="button" data-use-default={place} onClick={() => onForget(place)} style={{ ...LINK, flex: 'none' }}>Use default</button>
    </div>
  );
}

/**
 * Intelligence: the default provider of @bart (which @brainstorm and @discover follow) and of Build, then each agent's
 * default on each provider. `initial`: what api.settingsModels() gave, when it is already known (the tests' static render).
 */
export function Intelligence({ initial = null }) {
  const [settings, setSettings] = React.useState(initial);
  const [error, setError] = React.useState('');
  const [editing, setEditing] = React.useState(null); // { agent, provider, level }: the cell whose grid is open
  const [advanced, setAdvanced] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    const load = () => api.settingsModels().then((value) => { if (live) setSettings(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    load();
    // Another window saved, or forgot a pick.
    const off = api.onModelsChanged ? api.onModelsChanged(load) : () => {};
    return () => { live = false; off(); };
  }, []);
  // Each pick is saved as it is made: the next run starts there, in any window, with no restart.
  const done = (call) => call.then((value) => { setSettings(value); setError(''); }, (e) => setError(errorMessage(e)));
  const save = (patch) => done(api.saveSettingsModels(patch));
  const forget = (place) => done(api.clearModelChoice(place));
  if (!settings) return <div style={{ padding: '4px 10px 8px', ...text(12.5, error ? 'var(--red-600)' : '#8f8f8f') }}>{error || 'Loading…'}</div>;
  const providers = shownProviders(settings);
  const names = Object.fromEntries(providers.map((id) => [id, settings.models.providers[id].name]));
  const bartHome = defaultProvider(settings, 'bart'), buildHome = defaultProvider(settings, 'build');
  const row = (agent) => ({ settings, providers, agent, editing, onEdit: setEditing, onSave: save, home: agent === 'build' ? buildHome : bartHome });
  return (
    <div data-settings-intelligence="1">
      <div style={{ padding: '0 10px 8px', ...text(12, '#8f8f8f') }}>What each agent starts on when its line picks nothing. A model picked by hand is used next time instead, until you set that default here again.</div>
      <ProviderChoice field="bart" label="@bart, @brainstorm, @discover on" providers={providers} names={names} value={bartHome} onPick={(id) => save({ provider: id })} />
      <ProviderChoice field="build" label="Build and post-its on" providers={providers} names={names} value={buildHome} onPick={(id) => save({ buildProvider: id })} />
      <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_WIDTH}px repeat(${providers.length}, minmax(0, 1fr))`, columnGap: 6, padding: '10px 10px 2px' }}>
        <span />
        {providers.map((id) => (
          <span key={id} data-settings-column={id} style={{ minWidth: 0, ...HEAD, padding: '0 0 0 2px' }}>
            {names[id]}
            {settings.cli[id] && <span data-cli-note={id} style={{ display: 'block', marginTop: 3, letterSpacing: 0, textTransform: 'none', ...text(11, '#8f8f8f') }}>{settings.cli[id]}</span>}
          </span>
        ))}
      </div>
      {AGENT_ROWS.map(({ id, name, place, also }) => (
        <React.Fragment key={id}>
          <Row {...row(id)} label={name} />
          {place && <LastPick settings={settings} place={place} lead="Using your last pick" onForget={forget} />}
          {also && <LastPick settings={settings} place={also} lead="Post-its use your last pick" onForget={forget} />}
          {id === 'discover' && (
            <>
              <button type="button" data-settings-advanced="1" aria-expanded={advanced} onClick={() => { setAdvanced((value) => !value); if (editing && editing.agent === 'discover' && editing.level !== 'standard') setEditing(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 0 2px', padding: `0 10px 2px ${LABEL_WIDTH + 16}px`, border: 0, background: 'transparent', cursor: 'pointer', ...text(12, '#8f8f8f') }}>
                <span style={{ display: 'inline-block', width: 10, transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>›</span>Advanced
              </button>
              {advanced && ADVANCED_LEVELS.map((level) => <Row key={level.id} {...row('discover')} level={level.id} label={`${level.name} (--${level.id})`} indent />)}
            </>
          )}
        </React.Fragment>
      ))}
      {error && <div role="alert" style={{ padding: '6px 10px 0', ...text(12, 'var(--red-600)') }}>{error}</div>}
    </div>
  );
}

const ITEM = { padding: '8px 10px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' };

/** Test data (test mode only): what test mode's own gear offered until 2026-10-06. "Start as a new user…" leaves the test root as a new install has it. */
export function TestData({ test, close }) {
  return (
    <div role="menu" aria-label="Test data">
      <div role="menuitem" className="hov-wash" onClick={() => { close(); test.onReveal(); }} style={ITEM}>Reveal in Finder</div>
      <div role="menuitem" className="hov-wash" data-start-new-user="1" onClick={() => { close(); test.onStartNew(); }} style={ITEM}>Start as a new user…</div>
      <div role="menuitem" className="hov-wash" onClick={() => { close(); test.onReset(); }} style={{ ...ITEM, color: '#e70022' }}>Reset everything…</div>
    </div>
  );
}

// The panel's sections, in order. `shown` (optional) decides from the panel's props whether a section is there.
export const SECTIONS = Object.freeze([
  { id: 'intelligence', title: 'Intelligence', Body: Intelligence },
  { id: 'test', title: 'Test data · ~/.engelbart/test', shown: ({ test }) => !!(test && test.testMode), Body: TestData },
]);

/** `test` (a developer's copy only, else null): { testMode, onReveal, onStartNew, onReset }, for the Test data section. */
export default function Settings({ test = null }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);
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
  const sections = SECTIONS.filter((section) => !section.shown || section.shown({ test }));
  return (
    <div ref={ref} data-settings="1" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button type="button" className="hov-ink" title="Settings" aria-label="Settings" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}
        style={{ width: 30, height: 30, padding: 0, border: '1px solid transparent', borderRadius: '50%', background: 'transparent', cursor: 'pointer', font: '17px/1 var(--font-sans)', color: open ? '#171717' : '#8f8f8f', transition: 'color 120ms' }}>
        ⚙
      </button>
      {open && (
        <div data-overlay="1" data-settings-panel="1" role="dialog" aria-label="Settings"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 440, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 72px)', overflowY: 'auto', boxSizing: 'border-box', padding: '4px 4px 8px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
          {sections.map(({ id, title, Body }, index) => (
            <section key={id} data-settings-section={id} aria-label={title} style={index ? { marginTop: 8, paddingTop: 6, borderTop: '1px solid #eaeaea' } : undefined}>
              <div style={HEAD}>{title}</div>
              <Body test={test} close={close} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

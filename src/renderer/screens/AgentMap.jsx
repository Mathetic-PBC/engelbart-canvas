import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { sizeLabel, msLabel, exportPage, exportAsk, filterAsks, askText, askTime, askSections, pipelineLine, nodesText, agentInfo, FILTERS } from '../agent-map/runText.js';

// The Agent Viewer (2026-10-12; it was the Agent map; src/main/agent-map): a window for developers only, in a copy with
// test mode whether the mode is on or off, the app's renderer at ?view=agent-map. Asks: one row per thing asked (the main
// process groups the run log's records, asks.cjs), only what was typed and when, newest first, live (engelbart:agent-run),
// filtered to questions or Builds. The right side is the selected ask's pipeline in four sections (runText.js
// askSections): 1 what you typed, where, and what Bart (the classifier) saw; 2 its pick, or how the line reached its agent
// directly; 3 what the agent was sent; 4 what it did and wrote. A click also shows the line in its workspace
// (agentMap:reveal). Design: each agent as it is set up now, and which agents it hands work to. Plain and readable at a
// glance (2026-10-13): the window's sans-serif, monospace only for text blocks and commands, no colour but an error's;
// the sections start closed, each with a one-line summary, and a tool call is one row.
// Keys: j/k the next and previous ask, 1–4 a section, c copies the right side, e exports the ask (E every run).
export const KEYS_HELP = 'j/k ask · 1–4 section · c copy · e export (E all)';

const FONT = "13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace';
const RULE = '1px solid #ddd';
const S = {
  root: { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', font: FONT, color: '#111', background: '#fff' },
  bar: { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', borderBottom: RULE, flex: 'none' },
  tab: (on) => ({ font: FONT, background: 'none', border: 'none', borderBottom: on ? '2px solid #111' : '2px solid transparent', padding: '2px 0', cursor: 'pointer', fontWeight: on ? 600 : 400, color: '#111' }),
  button: { font: FONT, background: '#fff', border: RULE, padding: '1px 6px', cursor: 'pointer', color: '#111' },
  dim: { color: '#777' },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  list: { width: 340, flex: 'none', overflowY: 'auto', borderRight: RULE },
  row: (on) => ({ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 10px', borderBottom: '1px solid #eee', cursor: 'pointer', background: on ? '#f0f0f0' : 'transparent' }),
  detail: { flex: 1, overflowY: 'auto', padding: '8px 14px 40px' },
  pre: { font: MONO, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f6f6f6', border: '1px solid #e6e6e6', padding: 6, margin: '3px 0' },
  head: { cursor: 'pointer', padding: '4px 0', borderTop: RULE, marginTop: 6, userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  sub: { margin: '2px 0 2px 12px' },
  line: { cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  code: { font: MONO },
  error: { color: '#a00', border: '1px solid #e6b8b8', padding: 4, margin: '6px 0' },
};

/** Text shown only once it is opened: a block of documents can be large. */
function Expand({ label, text, open: wanted = false }) {
  const [open, setOpen] = useState(wanted);
  // A step's output opens when it arrives, after the step was drawn.
  useEffect(() => { if (wanted) setOpen(true); }, [wanted]);
  return (
    <div style={S.sub}>
      <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {label}</div>
      {open && <pre style={S.pre}>{text || '(empty)'}</pre>}
    </div>
  );
}

/**
 * One node of a section (runText.js askSections): a line, an error, or something that opens on its text and children,
 * one level at a time. A tool call is one row: its name, argument summary, time and result size; opened, its arguments
 * and result together.
 */
export function Node({ node }) {
  const [open, setOpen] = useState(!!node.open);
  // A finished step's output opens when it arrives, after the step was drawn.
  useEffect(() => { if (node.open) setOpen(true); }, [node.open]);
  if (node.error) return <div style={{ ...S.sub, ...S.error }}>{node.label}: {node.error}</div>;
  const arg = node.arg ? <> {node.command ? <code style={S.code}>{node.arg}</code> : node.arg}</> : null;
  const dim = node.dim ? <span style={S.dim}> {node.dim}</span> : null;
  if (node.plain) return <div style={S.sub}>{node.label}{arg}{dim}</div>;
  return (
    <div style={S.sub} data-node={node.tool ? 'tool' : undefined}>
      <div style={S.line} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {node.label}{arg}{dim}</div>
      {open && (
        <div>
          {node.text != null && <pre style={{ ...S.pre, marginLeft: 12 }}>{node.text === '' ? '(empty)' : node.text}</pre>}
          {(node.children || []).map((child, i) => <Node key={i} node={child} />)}
        </div>
      )}
    </div>
  );
}

/**
 * The selected ask: its line, its pipeline on one line, and four numbered sections, closed unless `opened` holds their
 * key; a closed one shows its summary beside its heading.
 */
export function AskDetail({ ask, opened = {}, onToggle = () => {} }) {
  const sections = askSections(ask);
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{askText(ask.text)}</div>
      <div style={S.dim} data-pipeline="1">{pipelineLine(ask)}</div>
      {sections.map((section) => (
        <div key={section.key} data-section={section.key} data-open={opened[section.key] ? '1' : '0'}>
          <div style={S.head} onClick={() => onToggle(section.key)}>{opened[section.key] ? '▾' : '▸'} <b>{section.title}</b>{!opened[section.key] && section.summary ? <span style={S.dim} data-summary={section.key}> {section.summary}</span> : null}</div>
          {opened[section.key] && section.nodes.map((node, i) => <Node key={i} node={node} />)}
        </div>
      ))}
    </div>
  );
}

const stepText = (step) => `${step.name} (${step.model}) at ${step.effort}`;

/** One agent's tools on each provider: a question agent's flags, Build's tools and overrides, the run step's own tools. */
function DesignTools({ tools }) {
  const claude = tools.anthropic, codex = tools.openai;
  return (
    <>
      {claude && <div style={S.sub}>tools · Claude: {claude.restricted && 'restricted · '}<code>--tools "{claude.tools}"</code> {claude.allowedTools != null && <code>--allowedTools "{claude.allowedTools}"</code>}{claude.settingSources && <> <code>--setting-sources {claude.settingSources}</code></>}</div>}
      {claude && claude.personal && <div style={{ ...S.sub, marginLeft: 24 }}>plus {claude.personal}</div>}
      {claude && claude.engelbart && <div style={{ ...S.sub, marginLeft: 24 }}>Engelbart's MCP tools: {claude.engelbart.join(', ')}</div>}
      {claude && claude.deny && <Expand label={<>refused to the edit tools <span style={S.dim}>{claude.deny.length} rules</span></>} text={claude.deny.join('\n')} />}
      {codex === null ? <div style={S.sub}>tools · Codex: <span style={S.dim}>none (Claude Code only)</span></div>
        : codex && codex.overrides ? <Expand label={<>tools · Codex: what codexOverrides sets <span style={S.dim}>{codex.overrides.length} -c values</span></>} text={codex.overrides.join('\n')} />
          : codex && <div style={S.sub}>tools · Codex: web search {codex.webSearch ? 'on' : 'off'} · paper MCP {codex.papers ? 'on' : 'off'} · sandbox {codex.sandbox}</div>}
    </>
  );
}

function DesignModels({ models }) {
  return (
    <>
      {models.rule && <div style={S.sub}>model: {models.rule}{models.fallback ? <span style={S.dim}> (now {stepText(models.fallback)})</span> : ''}</div>}
      {models.error && <div style={{ ...S.sub, color: '#a00' }}>{models.error}</div>}
      {Object.entries(models.providers || {}).map(([provider, set]) => (
        <div key={provider} style={S.sub}>
          models · {provider}{provider === models.inForce ? <b> (in force)</b> : ''}:{' '}
          {set.error ? <span style={{ color: '#a00' }}>{set.error}</span>
            : set.steps ? set.steps.map(stepText).join(' → ')
              : Object.entries(set.modes || {}).map(([mode, steps]) => `${mode}: ${steps.map(stepText).join(', ')}`).join(' · ')}
          {set.models && <span style={S.dim}> · offers {set.models.map((model) => `${model.name} (${model.model})`).join(', ')} at {set.efforts.join(', ')}</span>}
        </div>
      ))}
    </>
  );
}

export function Design({ design }) {
  if (!design) return <div style={S.dim}>Loading…</div>;
  return (
    <div>
      {design.agents.map((agent) => (
        <div key={agent.agent} style={{ borderTop: RULE, padding: '6px 0 10px' }}>
          <div><b>{agentInfo(agent.agent).name}</b>{agentInfo(agent.agent).token ? <span style={S.dim}> · {agentInfo(agent.agent).token}{agent.token && agent.agent !== agent.token ? ` · internally '${agent.agent}'` : ''}</span> : null}{agentInfo(agent.agent).inside ? <span style={S.dim}> · shown inside a Build's output</span> : null}</div>
          {agent.planned ? <div style={{ ...S.sub, ...S.dim }}>Planned, not built yet</div> : <DesignBody agent={agent} />}
          <div style={S.sub}>calls: {agent.calls && agent.calls.length ? agent.calls.map((call) => <span key={call.to}><b>{agentInfo(call.to).name}</b> <span style={S.dim}>({call.how})</span> </span>) : <span style={S.dim}>none</span>}</div>
        </div>
      ))}
    </div>
  );
}

function DesignBody({ agent }) {
  return (
    <>
      {agent.rules && <div style={S.sub}>rules, in order: {agent.rules.map((rule) => `${rule.when} → ${rule.to}`).join(' · ')}</div>}
      {agent.inputs && <div style={S.sub}>inputs: {agent.inputs.join(' · ')}</div>}
      {agent.prompt.note && <div style={{ ...S.sub, ...S.dim }}>system prompt: {agent.prompt.note}</div>}
      <Expand label={<>{agent.prompt.note ? 'prompt template' : 'system prompt'} <span style={S.dim}>{agent.prompt.note ? 'per Build' : agent.prompt.custom ? `custom (${agent.prompt.file})` : 'built-in'} · {sizeLabel(agent.prompt.text)}</span></>} text={agent.prompt.text} />
      {agent.prompt.quick && <Expand label={<>a quick task's system prompt <span style={S.dim}>{sizeLabel(agent.prompt.quick)}</span></>} text={agent.prompt.quick} />}
      <DesignTools tools={agent.tools} />
      {agent.reach && <div style={S.sub}>reach: <span style={S.dim}>{agent.reach}</span></div>}
      {agent.keeps && <div style={S.sub}>keeps: <span style={S.dim}>{agent.keeps}</span></div>}
      <DesignModels models={agent.models} />
      <div style={S.sub}>{agent.agent === 'build' ? 'turn time' : 'time'}: {Object.entries(agent.timeout).map(([key, ms]) => `${key} ${msLabel(ms)}`).join(' · ')}{agent.maxTurns ? ` · at most ${agent.maxTurns} turns` : ''}</div>
      {agent.slots && <div style={S.sub}>slots at once: {Object.entries(agent.slots).map(([key, n]) => `${key} ${n}`).join(' · ')}</div>}
      <div style={S.sub}>context, a new session:</div>
      {agent.context.blocks.map((block) => <div key={block.block} style={{ marginLeft: 24 }}>{block.block} <span style={S.dim}>— {block.note}</span></div>)}
      {agent.context.resumed.length ? <div style={S.sub}>{agent.agent === 'build' ? 'a later turn' : 'a resumed session'}: {agent.context.resumed.join('; ')}</div> : null}
      <div style={S.sub}>folders: {agent.context.dirs}</div>
      {agent.ends && <div style={S.sub}>a turn ends: {agent.ends.map((end) => <div key={end.line} style={{ marginLeft: 12 }}><code>{end.line}</code> <span style={S.dim}>— {end.means}</span></div>)}</div>}
      {agent.startedFrom && <div style={S.sub}>started from: {agent.startedFrom.join(' · ')}</div>}
    </>
  );
}


/** The list of asks, with its filter: only what was typed and when, a dot while it runs. */
export function AskList({ asks, selected, filter, onSelect, onFilter, now = Date.now() }) {
  const shown = filterAsks(asks, filter);
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, padding: '4px 10px', borderBottom: RULE }}>
        {FILTERS.map(([id, label]) => <button key={id} type="button" style={S.tab(filter === id)} onClick={() => onFilter(id)}>{label}</button>)}
      </div>
      {shown.length ? shown.map((ask) => (
        <div key={ask.id} data-ask={ask.id} style={S.row(ask.id === selected)} onClick={() => onSelect(ask.id)}>
          <span style={{ width: 10, flex: 'none', color: '#111' }} title={ask.status === 'running' ? 'running' : undefined}>{ask.status === 'running' ? '●' : ''}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{askText(ask.text)}</span>
          <span style={{ ...S.dim, flex: 'none' }}>{askTime(ask.at, now)}</span>
        </div>
      )) : <div style={{ padding: 10, ...S.dim }}>{asks.length ? 'None of these yet.' : 'Nothing asked yet. Type an @bart line, or start a Build, in any window.'}</div>}
    </div>
  );
}

export default function AgentMap() {
  const [tab, setTab] = useState('asks');
  const [asks, setAsks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [ask, setAsk] = useState(null);
  // Which sections are open (all start closed), kept when another ask is picked.
  const [opened, setOpened] = useState({});
  const [design, setDesign] = useState(null);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('all');
  const selectedRef = useRef(null);
  const refetch = useRef(null);
  const detailRef = useRef(null);
  selectedRef.current = selected;

  useEffect(() => { document.title = 'Agent Viewer'; }, []);
  // The asks, and the one in view, read again at most every 400 ms while runs change.
  const readSelected = useCallback((id) => api.agentAsk(id).then((full) => { if (full && full.id === selectedRef.current) setAsk(full); }).catch(() => {}), []);
  useEffect(() => {
    let live = true;
    api.agentAsks().then((list) => { if (!live) return; setAsks(list); setSelected((current) => current || (list[0] && list[0].id) || null); }).catch((error) => setNote(errorMessage(error)));
    const off = api.onAgentRun(() => {
      if (refetch.current) return;
      refetch.current = setTimeout(() => {
        refetch.current = null;
        api.agentAsks().then((list) => { if (!live) return; setAsks(list); setSelected((current) => current || (list[0] && list[0].id) || null); }).catch(() => {});
        if (selectedRef.current) void readSelected(selectedRef.current);
      }, 400);
    });
    return () => { live = false; off(); clearTimeout(refetch.current); refetch.current = null; };
  }, [readSelected]);
  useEffect(() => {
    if (!selected) { setAsk(null); return; }
    let live = true;
    api.agentAsk(selected).then((full) => { if (live) setAsk(full); }).catch((error) => setNote(errorMessage(error)));
    return () => { live = false; };
  }, [selected]);
  useEffect(() => { if (tab === 'design') api.agentDesign().then(setDesign).catch((error) => setNote(errorMessage(error))); }, [tab]);

  // A row clicked: its pipeline on the right, and its line shown in the window of its project.
  const pick = useCallback((id) => {
    setSelected(id);
    const held = asks.find((entry) => entry.id === id);
    if (!held) return;
    if (!held.place) { setNote('No line was kept for this ask (asked before the Viewer kept them).'); return; }
    api.revealAsk({ place: held.place, routedTo: held.routedTo, buildId: held.buildId }).then((shown) => setNote(shown ? '' : 'No window to show it in.')).catch((error) => setNote(errorMessage(error)));
  }, [asks]);
  const toggle = useCallback((key) => setOpened((current) => ({ ...current, [key]: !current[key] })), []);
  const exportRuns = useCallback(async (all) => {
    try {
      if (all) {
        const records = (await Promise.all((await api.agentRuns()).map((run) => api.agentRun(run.id)))).filter(Boolean);
        if (!records.length) { setNote('Nothing to export.'); return; }
        const saved = await api.exportAgentRuns(exportPage(records, 'Agent runs'), `agent-runs-${new Date().toISOString().slice(0, 10)}`);
        setNote(saved ? `Saved ${saved}` : 'Not saved.');
        return;
      }
      if (!ask) { setNote('Nothing to export.'); return; }
      const saved = await api.exportAgentRuns(exportAsk(ask), `agent-ask-${ask.routedTo}-${String(ask.id).replace(/^(route-|build:)/, '').slice(0, 8)}`);
      setNote(saved ? `Saved ${saved}` : 'Not saved.');
    } catch (error) { setNote(errorMessage(error)); }
  }, [ask]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
      const shown = filterAsks(asks, filter);
      const at = shown.findIndex((entry) => entry.id === selected);
      if (event.key === 'j' && shown.length) setSelected(shown[Math.min(shown.length - 1, at + 1)].id);
      else if (event.key === 'k' && shown.length) setSelected(shown[Math.max(0, at - 1)].id);
      else if (/^[1-4]$/.test(event.key)) {
        const key = event.key;
        setTab('asks');
        toggle(key);
        setTimeout(() => { const el = detailRef.current && detailRef.current.querySelector(`[data-section="${key}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' }); }, 0);
      } else if (event.key === 'c' && ask) {
        const text = askSections(ask).map((section) => `===== ${section.title} =====\n${nodesText(section.nodes)}`).join('\n\n');
        api.copyText(text.slice(0, 400000)).then(() => setNote(`Copied the ask${text.length > 400000 ? ' (first 400,000 characters)' : ''}.`)).catch((error) => setNote(errorMessage(error)));
      } else if (event.key === 'e' || event.key === 'E') void exportRuns(event.key === 'E');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asks, selected, ask, exportRuns, filter, toggle]);

  const list = useMemo(() => <AskList asks={asks} selected={selected} filter={filter} onSelect={pick} onFilter={setFilter} />, [asks, selected, filter, pick]);

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <b title={KEYS_HELP}>Agent Viewer</b>
        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <button type="button" style={S.tab(tab === 'asks')} onClick={() => setTab('asks')}>Asks</button>
          <span style={S.dim}>|</span>
          <button type="button" style={S.tab(tab === 'design')} onClick={() => setTab('design')}>Design</button>
        </span>
        <span style={{ flex: 1, ...S.dim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>
        <button type="button" style={S.button} title={KEYS_HELP} disabled={!ask} onClick={() => exportRuns(false)}>Export ask</button>
        <button type="button" style={S.button} title={KEYS_HELP} disabled={!asks.length} onClick={() => exportRuns(true)}>Export all</button>
      </div>
      {tab === 'asks' ? (
        <div style={S.body}>
          <div style={S.list}>{list}</div>
          <div ref={detailRef} style={S.detail}>{ask ? <AskDetail ask={ask} opened={opened} onToggle={toggle} /> : <div style={S.dim}>{asks.length ? 'Loading…' : ''}</div>}</div>
        </div>
      ) : (
        <div style={{ ...S.detail, flex: 1 }}><Design design={design} /></div>
      )}
    </div>
  );
}

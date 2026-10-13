import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api.js';
import Benchmark from './Benchmark.jsx';
import { contextBlocks, sizeLabel, json, firstWords, writtenText, timeLabel, msLabel, sectionText, exportPage, runLabel, agentInfo, createdLines, rowText, rowLine, listedRuns, placeLabel, projectNames } from '../agent-map/runText.js';

// The Agent Viewer (2026-10-12; it was the Agent map, and the internal names stay: src/main/agent-map): a window for developers only, the app's renderer at ?view=agent-map.
// Its first design again (2026-10-13: the Agent Viewer's asks and pipeline sections were taken out; main's asks, reveal and
// the run log are unchanged), with every agent there is now: @create's runs, its Design entry and the rows it kept.
// Runs: every @bart the model routed or that failed (the router, 2026-10-12: where it sent the line; a rule's pick is not listed), @chat, @brainstorm, @discover and @create run, each Build turn and each run step after one, newest first, live
// (engelbart:agent-run), all in one list, and the one selected in sections: its system prompt, its context
// block by block, each model step (the input, its tool calls, what it said) and what was written (a run step: its
// runnables). Design: one agent at a time, picked from a row of tabs, as it is set up now and which agents it hands work to.
// Benchmark (2026-10-13, ./Benchmark.jsx): every Chat question in the notes, its saved answer beside it asked again now.
// Plain and dense on purpose: one font, small type, thin rules. Less text (2026-10-13): no filter tabs, status dots, size
// notes beside the sections, run header, router line or key legend; a failed run still says why. A row reads as the person's
// words over the agent in plain words, first message or reply, the model and the time (RunList).
// Keys, not shown: j/k the next and previous run, 1–4 a section, c copies the open section, e exports the run (E every run).

const SECTIONS = [['system', 'System prompt'], ['context', 'Context'], ['steps', 'Steps'], ['written', 'Written']];
const FONT = '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace';
const RULE = '1px solid #ddd';
const S = {
  root: { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', font: FONT, color: '#111', background: '#fff' },
  bar: { display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', borderBottom: RULE, flex: 'none' },
  tab: (on) => ({ font: FONT, background: 'none', border: 'none', borderBottom: on ? '2px solid #111' : '2px solid transparent', padding: '2px 0', cursor: 'pointer', fontWeight: on ? 600 : 400, color: '#111' }),
  button: { font: FONT, background: '#fff', border: RULE, padding: '1px 6px', cursor: 'pointer', color: '#111' },
  dim: { color: '#777' },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  list: { width: 360, flex: 'none', overflowY: 'auto', borderRight: RULE },
  row: (on) => ({ padding: '5px 10px', borderBottom: '1px solid #eee', cursor: 'pointer', background: on ? '#eef3ff' : 'transparent' }),
  line: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  place: { padding: '6px 10px 2px', fontSize: 11, color: '#777', borderBottom: '1px solid #eee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: { flex: 1, overflowY: 'auto', padding: '8px 14px 40px' },
  pre: { font: FONT, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f6f6f6', border: '1px solid #e6e6e6', padding: 6, margin: '3px 0' },
  head: { cursor: 'pointer', padding: '3px 0', borderTop: RULE, marginTop: 6, userSelect: 'none' },
  sub: { margin: '2px 0 2px 14px' },
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

function Section({ n, id, title, open, onToggle, children }) {
  return (
    <div>
      <div style={S.head} onClick={() => onToggle(id)}>{open ? '▾' : '▸'} <b>{n} {title}</b></div>
      {open && <div>{children}</div>}
    </div>
  );
}

function ToolCall({ tool, from }) {
  const [open, setOpen] = useState(false);
  const result = tool.result;
  return (
    <div style={{ ...S.sub, borderLeft: '1px solid #ccc', paddingLeft: 8 }}>
      <div style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} <b>{tool.name}</b> <span style={S.dim}>+{msLabel(Math.max(0, tool.at - from))}{tool.ms != null ? ` · took ${msLabel(tool.ms)}` : ' · running'}{result ? ` · ${result.size.toLocaleString('en-US')} chars` : ''}{result && result.exitCode != null ? ` · exit ${result.exitCode}` : ''}</span>{result && result.error && <span style={{ color: '#a00' }}> · error</span>}
        {!open && <span style={S.dim}> {firstWords(json(tool.input).replace(/\s+/g, ' '), 14)}</span>}
      </div>
      {open && (
        <div>
          <div style={S.dim}>arguments</div>
          <pre style={S.pre}>{json(tool.input) || '(none)'}</pre>
          {result && <><div style={S.dim}>result, first 2,000 characters</div><pre style={S.pre}>{result.excerpt || '(empty)'}</pre></>}
        </div>
      )}
    </div>
  );
}

function Step({ step, n }) {
  return (
    <div style={{ margin: '6px 0 10px 14px' }}>
      <div><b>step {n}</b> {step.name || step.model} <span style={S.dim}>({step.model}) · {step.effort}{step.ms != null ? ` · ${msLabel(step.ms)}` : step.output == null ? ' · running' : ''}</span>{step.escalated && <b style={{ color: '#9a6700' }}> · escalated</b>}</div>
      <Expand label={<>input <span style={S.dim}>{sizeLabel(step.input)}</span></>} text={step.input} />
      <div style={{ ...S.sub, ...S.dim }}>tool calls ({step.tools.length}{step.toolsDropped ? `, and ${step.toolsDropped.toLocaleString('en-US')} more not kept` : ''})</div>
      {step.tools.map((tool, i) => <ToolCall key={tool.id || i} tool={tool} from={step.at} />)}
      <Expand label={<>output <span style={S.dim}>{step.output == null ? 'running' : sizeLabel(step.output)}</span></>} text={step.output == null ? '' : step.output} open={step.output != null} />
    </div>
  );
}

export function RunDetail({ record, open, onToggle }) {
  const blocks = contextBlocks(record);
  return (
    <div>
      {record.routedFrom && <div style={S.dim}>handed over by Bart: {record.routedFrom}{record.corrected ? ` · the person picked ${record.corrected} instead` : ''}</div>}
      {record.error && <div style={S.error}>{record.status}: {record.error}</div>}
      <Section n={1} id="system" title="System prompt" open={open === 'system'} onToggle={onToggle}>
        <pre style={S.pre}>{record.system}</pre>
      </Section>
      <Section n={2} id="context" title="Context" open={open === 'context'} onToggle={onToggle}>
        {blocks.map((block) => <Expand key={block.key} label={<>{block.label} <span style={S.dim}>{block.text ? sizeLabel(block.text) : 'none'}</span></>} text={block.text} />)}
      </Section>
      <Section n={3} id="steps" title="Steps" open={open === 'steps'} onToggle={onToggle}>
        {record.steps.length ? record.steps.map((step, i) => <Step key={i} step={step} n={i + 1} />) : <div style={{ ...S.sub, ...S.dim }}>no model run</div>}
      </Section>
      <Section n={4} id="written" title="Written" open={open === 'written'} onToggle={onToggle}>
        <pre style={S.pre}>{writtenText(record) || '(nothing)'}</pre>
        {record.agent === 'create' && <><div style={{ ...S.sub, ...S.dim }}>kept in the library</div><pre style={S.pre}>{createdLines(record)}</pre></>}
      </Section>
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
      {claude && claude.personal && <div style={{ ...S.sub, marginLeft: 28 }}>plus {claude.personal}</div>}
      {claude && claude.engelbart && <div style={{ ...S.sub, marginLeft: 28 }}>Engelbart's MCP tools: {claude.engelbart.join(', ')}</div>}
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

/** One agent at a time: a row of tabs, one per agent in design.agents' order, and the picked one's block (the first if none or unknown). */
export function Design({ design, agent: picked, onPick }) {
  if (!design) return <div style={S.dim}>Loading…</div>;
  const agent = design.agents.find((held) => held.agent === picked) || design.agents[0];
  if (!agent) return <div style={S.dim}>No agents.</div>;
  const info = agentInfo(agent.agent);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, paddingBottom: 4 }}>
        {design.agents.map((held) => <button key={held.agent} type="button" style={S.tab(held.agent === agent.agent)} onClick={() => onPick && onPick(held.agent)}>{agentInfo(held.agent).name}</button>)}
      </div>
      <div style={{ borderTop: RULE, padding: '6px 0 10px' }}>
        <div><b>{info.name}</b>{info.token ? <span style={S.dim}> · {info.token}{agent.token && agent.agent !== agent.token ? ` · internally '${agent.agent}'` : ''}</span> : null}{info.inside ? <span style={S.dim}> · shown inside a Build's output</span> : null}</div>
        {agent.planned ? <div style={{ ...S.sub, ...S.dim }}>Planned, not built yet</div> : <DesignBody agent={agent} />}
        <div style={S.sub}>calls: {agent.calls && agent.calls.length ? agent.calls.map((call) => <span key={call.to}><b>{agentInfo(call.to).name}</b> <span style={S.dim}>({call.how})</span> </span>) : <span style={S.dim}>none</span>}</div>
      </div>
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
      {agent.context.blocks.map((block) => <div key={block.block} style={{ marginLeft: 28 }}>{block.block} <span style={S.dim}>— {block.note}</span></div>)}
      {agent.context.resumed.length ? <div style={S.sub}>{agent.agent === 'build' ? 'a later turn' : 'a resumed session'}: {agent.context.resumed.join('; ')}</div> : null}
      <div style={S.sub}>folders: {agent.context.dirs}</div>
      {agent.ends && <div style={S.sub}>a turn ends: {agent.ends.map((end) => <div key={end.line} style={{ marginLeft: 14 }}><code>{end.line}</code> <span style={S.dim}>— {end.means}</span></div>)}</div>}
      {agent.startedFrom && <div style={S.sub}>started from: {agent.startedFrom.join(' · ')}</div>}
    </>
  );
}

/**
 * The list of runs, newest first (2026-10-13): each row the person's words, then the agent in plain words, first message
 * or reply, the model and the time; a dim "Project / Workspace" header over a row whose place differs from the row above.
 * A rule's router pick is not listed (listedRuns). Hover gives the place, the Build id and the whole text.
 */
export function RunList({ runs, selected, onSelect }) {
  const shown = listedRuns(runs), names = projectNames(runs);
  let above = null;
  return (
    <div>
      {shown.length ? shown.map((run) => {
        const place = placeLabel(run, names), header = place !== above;
        above = place;
        const hover = [place, run.buildId ? `Build ${run.buildId}` : '', rowText(run)].filter(Boolean).join('\n');
        return (
          <React.Fragment key={run.id}>
            {header && place ? <div style={S.place}>{place}</div> : null}
            <div style={S.row(run.id === selected)} title={hover} onClick={() => onSelect(run.id)}>
              <div style={S.line}>{rowText(run)}</div>
              <div style={{ display: 'flex', gap: 8, ...S.dim }}><span style={{ ...S.line, flex: 1, minWidth: 0 }}>{rowLine(run)}</span><span style={{ flex: 'none' }}>{timeLabel(run.at)}</span></div>
            </div>
          </React.Fragment>
        );
      }) : <div style={{ padding: 10, ...S.dim }}>No runs yet. Ask @bart, @chat, @brainstorm, @discover or @create, or start a Build, in any window.</div>}
    </div>
  );
}

export default function AgentMap() {
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [record, setRecord] = useState(null);
  const [open, setOpen] = useState('steps');
  const [design, setDesign] = useState(null);
  const [note, setNote] = useState('');
  const [agent, setAgent] = useState(null);
  const selectedRef = useRef(null);
  const refetch = useRef(null);
  selectedRef.current = selected;

  useEffect(() => { document.title = 'Agent Viewer'; }, []);
  useEffect(() => {
    let live = true;
    api.agentRuns().then((list) => { if (!live) return; setRuns(list); const first = listedRuns(list)[0]; setSelected((current) => current || (first && first.id) || null); }).catch((error) => setNote(errorMessage(error)));
    const off = api.onAgentRun((summary) => {
      setRuns((list) => [summary, ...list.filter((run) => run.id !== summary.id)].sort((a, b) => b.at - a.at));
      if (listedRuns([summary]).length) setSelected((current) => current || summary.id);
      // The run in view is read again, at most every 400 ms while it changes.
      if (summary.id === selectedRef.current && !refetch.current) {
        refetch.current = setTimeout(() => { refetch.current = null; api.agentRun(summary.id).then((full) => { if (full && full.id === selectedRef.current) setRecord(full); }).catch(() => {}); }, 400);
      }
    });
    return () => { live = false; off(); clearTimeout(refetch.current); refetch.current = null; };
  }, []);
  useEffect(() => {
    if (!selected) { setRecord(null); return; }
    let live = true;
    api.agentRun(selected).then((full) => { if (live) setRecord(full); }).catch((error) => setNote(errorMessage(error)));
    return () => { live = false; };
  }, [selected]);
  useEffect(() => { if (tab === 'design') api.agentDesign().then(setDesign).catch((error) => setNote(errorMessage(error))); }, [tab]);

  const toggle = useCallback((id) => setOpen((current) => (current === id ? null : id)), []);
  const exportRuns = useCallback(async (all) => {
    try {
      const records = all ? (await Promise.all(runs.map((run) => api.agentRun(run.id)))).filter(Boolean) : record ? [record] : [];
      if (!records.length) { setNote('Nothing to export.'); return; }
      const name = all ? `agent-runs-${new Date().toISOString().slice(0, 10)}` : `agent-run-${records[0].agent}-${records[0].id.slice(0, 8)}`;
      const saved = await api.exportAgentRuns(exportPage(records, all ? 'Agent runs' : `${runLabel(records[0])}: ${firstWords(records[0].question, 12)}`), name);
      setNote(saved ? `Saved ${saved}` : 'Not saved.');
    } catch (error) { setNote(errorMessage(error)); }
  }, [runs, record]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
      // j/k move over the rows the list shows.
      const shown = listedRuns(runs), at = shown.findIndex((run) => run.id === selected);
      if (event.key === 'j' && shown.length) setSelected(shown[Math.min(shown.length - 1, at + 1)].id);
      else if (event.key === 'k' && shown.length) setSelected(shown[Math.max(0, at - 1)].id);
      else if (/^[1-4]$/.test(event.key)) { setTab('runs'); setOpen(SECTIONS[Number(event.key) - 1][0]); }
      else if (event.key === 'c' && record && open) {
        const text = sectionText(record, open);
        api.copyText(text.slice(0, 400000)).then(() => setNote(`Copied ${SECTIONS.find(([id]) => id === open)[1]}${text.length > 400000 ? ' (first 400,000 characters)' : ''}.`)).catch((error) => setNote(errorMessage(error)));
      } else if (event.key === 'e' || event.key === 'E') void exportRuns(event.key === 'E');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runs, selected, record, open, exportRuns]);

  const list = useMemo(() => <RunList runs={runs} selected={selected} onSelect={setSelected} />, [runs, selected]);

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <button type="button" style={S.tab(tab === 'runs')} onClick={() => setTab('runs')}>Runs</button>
        <button type="button" style={S.tab(tab === 'design')} onClick={() => setTab('design')}>Design</button>
        <button type="button" style={S.tab(tab === 'benchmark')} onClick={() => setTab('benchmark')}>Benchmark</button>
        <span style={{ flex: 1 }} />
        <span style={S.dim}>{note}</span>
        <button type="button" style={S.button} disabled={!record} onClick={() => exportRuns(false)}>Export run</button>
        <button type="button" style={S.button} disabled={!runs.length} onClick={() => exportRuns(true)}>Export all</button>
      </div>
      {tab === 'runs' ? (
        <div style={S.body}>
          <div style={S.list}>{list}</div>
          <div style={S.detail}>{record ? <RunDetail record={record} open={open} onToggle={toggle} /> : <div style={S.dim}>{runs.length ? 'Loading…' : ''}</div>}</div>
        </div>
      ) : tab === 'design' ? (
        <div style={{ ...S.detail, flex: 1 }}><Design design={design} agent={agent} onPick={setAgent} /></div>
      ) : (
        <Benchmark />
      )}
    </div>
  );
}

import React from 'react';
import { api, errorMessage } from '../api.js';
import StagePopover from './StagePopover.jsx';
import './recordings.css';

export const recordingTime = ms => { const seconds = Math.floor(Math.max(0, ms || 0) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
export const isRecording = value => value && ['starting', 'recording'].includes(value.status);

export function useRecording() {
  const [recording, setRecording] = React.useState(null);
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    let alive = true, heard = false;
    const off = api.onRecording(value => { heard = true; if (alive) setRecording(value); });
    api.recordingCurrent().then(value => { if (alive && !heard) setRecording(value); }).catch(() => {});
    return () => { alive = false; off(); };
  }, []);
  React.useEffect(() => {
    if (!isRecording(recording)) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording?.id, recording?.status]);
  return isRecording(recording) && recording.startedAt ? { ...recording, durationMs: Math.max(recording.durationMs, now - recording.startedAt) } : recording;
}

export default function Recordings({ projectId, url, recording, slotRef, surfaceRef, onClose }) {
  const [list, setList] = React.useState([]), [loading, setLoading] = React.useState(true), [selected, setSelected] = React.useState(null);
  const [capture, setCapture] = React.useState(null), [error, setError] = React.useState(''), [warning, setWarning] = React.useState('');
  const [playback, setPlayback] = React.useState({ ready: false, playing: false, at: 0, duration: 0 });
  const [revision, setRevision] = React.useState(0);
  const frame = React.useRef(null), close = React.useRef(null);
  // Metadata updates use a separate channel so an older title finishing cannot
  // replace the current recording indicator or restart an open replay.
  React.useEffect(() => api.onRecordingUpdated(row => { if (row.projectId === projectId) setRevision(value => value + 1); }), [projectId]);
  React.useEffect(() => {
    const states = new Map();
    return api.onSandboxProgress(({ run }) => {
      if (!run) return;
      const state = `${run.status}:${run.preview_url}`;
      if (states.get(run.library_id) !== state) { states.set(run.library_id, state); setRevision(value => value + 1); }
    });
  }, []);
  React.useEffect(() => { close.current?.focus(); }, [selected]);
  React.useEffect(() => {
    let alive = true;
    if (!url) { setList([]); setLoading(false); return undefined; }
    api.recordingList(projectId, url).then(rows => { if (alive) { setList(rows); setLoading(false); } }).catch(e => { if (alive) { setError(errorMessage(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [projectId, url, recording?.id, recording?.status, revision]);
  React.useEffect(() => {
    let alive = true;
    setCapture(null); setError(''); setWarning(''); setPlayback({ ready: false, playing: false, at: 0, duration: 0 });
    if (selected) api.recordingRead(projectId, selected.id).then(value => { if (alive) setCapture(value); }).catch(e => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [selected, projectId]);
  React.useEffect(() => {
    const receive = event => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'engelbart://replay' || event.data?.type !== 'engelbart:replay') return;
      const value = event.data;
      if (value.error) setError(value.error);
      if (value.warning) setWarning(value.warning);
      if (value.ready) setPlayback({ ready: true, playing: value.playing, at: value.at, duration: value.duration });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const tell = message => frame.current?.contentWindow.postMessage({ type: 'engelbart:replay', ...message }, 'engelbart://replay');
  const selectedName = selected && (list.find(row => row.id === selected.id)?.name || selected.name);
  const progress = playback.duration ? Math.min(100, Math.max(0, playback.at / playback.duration * 100)) : 0;
  if (!selected) return <StagePopover slotRef={slotRef} surfaceRef={surfaceRef} onDismiss={onClose} name="Recordings" className="recordings-popover" data-recordings="1">
    <div className="stage-popover-heading" data-popover-heading="1">
      <strong>Recordings</strong>
      <button type="button" onClick={onClose} aria-label="Close recordings">×</button>
    </div>
    {error && <p className="recording-error" role="alert">{error}</p>}
    <div className="recording-list" aria-busy={loading}>
      {loading && <p className="recording-empty">Loading recordings…</p>}
      {!loading && !list.length && <p className="recording-empty">{url ? 'No recordings for this website yet.' : 'Open a website to see its recordings.'}</p>}
      {list.map(row => <button type="button" className="recording-row" key={row.id} disabled={isRecording(row)} onClick={() => setSelected(row)}>
        <span><span className="recording-name" title={row.name}>{row.name}</span><span className="recording-detail" title={row.url}>{row.sourceName || row.url}</span></span>
        <span className="recording-duration">{recordingTime(row.durationMs)}</span>
        <span aria-hidden="true">›</span>
      </button>)}
    </div>
  </StagePopover>;
  return <section className="stage-recordings" data-overlay="1" data-recordings="1" aria-label="Recording playback" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSelected(null); } }}>
    <header>
      <button type="button" onClick={() => setSelected(null)} aria-label="Back to recordings">←</button>
      <span className="recording-heading">{selectedName}</span>
      <span className="recording-quiet">Playback</span>
      <button type="button" ref={close} onClick={onClose} aria-label="Return to page" title="Return to page">×</button>
    </header>
    {error && <p className="recording-error" role="alert">{error}</p>}
      {(selected.warnings?.length > 0 || warning) && <details className="recording-warnings"><summary>Capture limitations</summary><ul>{[...new Set([...(selected.warnings || []), ...(warning ? [warning] : [])])].map(text => <li key={text}>{text}</li>)}</ul></details>}
      <div className="recording-screen">
        {!capture && !error && <p className="recording-empty">Opening recording…</p>}
        {capture && <iframe key={selected.id} ref={frame} src="engelbart://replay/recording-player.html" title="Recorded page" sandbox="allow-scripts allow-same-origin" onLoad={() => tell({ action: 'load', batches: capture.batches })} />}
      </div>
      <footer className="recording-controls" aria-label="Playback controls">
        <button type="button" className="recording-play" aria-label={playback.playing ? 'Pause recording' : 'Play recording'} title={playback.playing ? 'Pause' : 'Play'} disabled={!playback.ready} onClick={() => tell({ action: playback.playing ? 'pause' : 'play' })}>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">{playback.playing ? <><rect x="5" y="4" width="3.5" height="12" rx=".8" /><rect x="11.5" y="4" width="3.5" height="12" rx=".8" /></> : <path d="M6 3.8a.8.8 0 0 1 1.2-.7l9 6.2a.85.85 0 0 1 0 1.4l-9 6.2a.8.8 0 0 1-1.2-.7Z" />}</svg>
        </button>
        <input className="recording-seek" type="range" aria-label="Position in recording" aria-valuetext={`${recordingTime(playback.at)} of ${recordingTime(playback.duration)}`} min="0" max={Math.max(1, playback.duration)} step="50" value={Math.min(playback.at, playback.duration)} style={{ '--recording-progress': `${progress}%` }} disabled={!playback.ready} onChange={event => tell({ action: 'seek', at: Number(event.target.value) })} />
        <span className="recording-clock"><span>{recordingTime(playback.at)}</span><span className="recording-total"> / {recordingTime(playback.duration)}</span></span>
      </footer>
  </section>;
}

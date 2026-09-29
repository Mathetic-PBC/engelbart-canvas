import React from 'react';
import { api, errorMessage } from '../api.js';
import { useSessionState, sessionValue, saveSessionValue } from '../session-ui.js';
import StagePopover from './StagePopover.jsx';
import './recordings.css';

export const recordingTime = ms => { const seconds = Math.floor(Math.max(0, ms || 0) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
export const isRecording = value => value && ['starting', 'recording'].includes(value.status);

function PlayIcon({ playing }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">{playing ? <><rect x="5" y="4" width="3.5" height="12" rx=".8" /><rect x="11.5" y="4" width="3.5" height="12" rx=".8" /></> : <path d="M6 3.8a.8.8 0 0 1 1.2-.7l9 6.2a.85.85 0 0 1 0 1.4l-9 6.2a.8.8 0 0 1-1.2-.7Z" />}</svg>;
}

function SkipIcon({ forward }) {
  return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
    <g transform={forward ? 'translate(24 0) scale(-1 1)' : undefined} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8a9 9 0 1 1-1 7M4 3v5h5" /></g>
    <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="9" fontWeight="600" fontFamily="sans-serif">10</text>
  </svg>;
}

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
  const [list, setList] = React.useState([]), [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = useSessionState(`recordings:${projectId}:${url || 'none'}:selected`, null);
  const [capture, setCapture] = React.useState(null), [error, setError] = React.useState('');
  const [playback, setPlayback] = React.useState({ ready: false, playing: false, at: 0, duration: 0 });
  const [fullscreen, setFullscreen] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const frame = React.useRef(null), close = React.useRef(null), player = React.useRef(null);
  const restorePlayback = React.useRef(true);
  const selection = React.useRef(selected); selection.current = selected;
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
    const update = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === player.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  React.useEffect(() => {
    let alive = true;
    if (!url) { setList([]); setLoading(false); return undefined; }
    api.recordingList(projectId, url).then(rows => { if (alive) { setList(rows); setLoading(false); } }).catch(e => { if (alive) { setError(errorMessage(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [projectId, url, recording?.id, recording?.status, revision]);
  React.useEffect(() => {
    let alive = true;
    setCapture(null); setError(''); setPlayback({ ready: false, playing: false, at: 0, duration: 0 });
    restorePlayback.current = true;
    if (selected) api.recordingRead(projectId, selected.id).then(value => { if (alive) setCapture(value); }).catch(e => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [selected, projectId]);
  React.useEffect(() => {
    const receive = event => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'engelbart://replay' || event.data?.type !== 'engelbart:replay') return;
      const value = event.data;
      if (value.error) setError(value.error);
      if (value.ready) {
        const key = `recording-position:${projectId}:${selection.current?.id}`;
        if (restorePlayback.current) {
          restorePlayback.current = false;
          const at = sessionValue(key, 0);
          if (at > 0) { frame.current.contentWindow.postMessage({ type: 'engelbart:replay', action: 'seek', at }, 'engelbart://replay'); return; }
        }
        setPlayback({ ready: true, playing: value.playing, at: value.at, duration: value.duration });
        if (selection.current) saveSessionValue(key, value.at);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const tell = message => frame.current?.contentWindow.postMessage({ type: 'engelbart:replay', ...message }, 'engelbart://replay');
  const togglePlayback = () => { if (playback.ready) tell({ action: playback.playing ? 'pause' : 'play' }); };
  const seek = at => { if (playback.ready) tell({ action: 'seek', at: Math.min(playback.duration, Math.max(0, at)) }); };
  const toggleFullscreen = () => {
    const change = document.fullscreenElement === player.current ? document.exitFullscreen() : player.current?.requestFullscreen();
    change?.catch(() => {});
  };
  const leavePlayer = callback => {
    if (document.fullscreenElement === player.current) document.exitFullscreen().catch(() => {});
    callback();
  };
  const handleKeyDown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.isContentEditable) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (fullscreen) toggleFullscreen(); else setSelected(null);
      return;
    }
    if (event.target.matches('input, select, textarea')) return;
    const key = event.key.toLowerCase();
    if (key === 'k' || (key === ' ' && !event.target.closest('button'))) { event.preventDefault(); togglePlayback(); }
    else if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); seek(playback.at + (key === 'arrowleft' ? -10000 : 10000)); }
    else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    else return;
    event.stopPropagation();
  };
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
  return <section ref={player} className="stage-recordings" data-overlay="1" data-recordings="1" aria-label="Recording playback" onKeyDown={handleKeyDown}>
    <header>
      <button type="button" onClick={() => leavePlayer(() => setSelected(null))} aria-label="Back to recordings" title="Back to recordings"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m12 5-7 7 7 7M5 12h14" /></svg></button>
      <span className="recording-heading" title={selectedName}>{selectedName}</span>
      <button type="button" ref={close} onClick={() => leavePlayer(onClose)} aria-label="Return to page" title="Return to page"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    {error && <p className="recording-error" role="alert">{error}</p>}
      <div className="recording-screen">
        {!capture && !error && <p className="recording-empty">Opening recording…</p>}
        {capture && <iframe key={selected.id} ref={frame} src="engelbart://replay/recording-player.html" title="Recorded page" sandbox="allow-scripts allow-same-origin" onLoad={() => tell({ action: 'load', batches: capture.batches })} />}
        {playback.ready && <button type="button" className="recording-screen-toggle" aria-label={playback.playing ? 'Pause video' : 'Play video'} onClick={togglePlayback}>
          {!playback.playing && <span className="recording-center-play"><PlayIcon /></span>}
        </button>}
      </div>
      <footer className="recording-controls" aria-label="Playback controls">
        <input className="recording-seek" type="range" aria-label="Position in recording" aria-valuetext={`${recordingTime(playback.at)} of ${recordingTime(playback.duration)}`} min="0" max={Math.max(1, playback.duration)} step="50" value={Math.min(playback.at, playback.duration)} style={{ '--recording-progress': `${progress}%` }} disabled={!playback.ready} onChange={event => seek(Number(event.target.value))} />
        <div className="recording-control-row">
          <button type="button" className="recording-play" aria-label={playback.playing ? 'Pause recording' : 'Play recording'} title={playback.playing ? 'Pause (K)' : 'Play (K)'} disabled={!playback.ready} onClick={togglePlayback}><PlayIcon playing={playback.playing} /></button>
          <button type="button" aria-label="Back 10 seconds" title="Back 10 seconds (←)" disabled={!playback.ready} onClick={() => seek(playback.at - 10000)}><SkipIcon /></button>
          <button type="button" aria-label="Forward 10 seconds" title="Forward 10 seconds (→)" disabled={!playback.ready} onClick={() => seek(playback.at + 10000)}><SkipIcon forward /></button>
          <span className="recording-clock"><span>{recordingTime(playback.at)}</span><span className="recording-total"> / {recordingTime(playback.duration)}</span></span>
          <button type="button" className="recording-fullscreen" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={toggleFullscreen}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={fullscreen ? 'M9 3v6H3m12-6v6h6M3 15h6v6m12-6h-6v6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6'} /></svg></button>
        </div>
      </footer>
  </section>;
}

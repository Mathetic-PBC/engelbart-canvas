import '@xterm/xterm/css/xterm.css';
import '@fontsource/caveat/400.css';
import '@fontsource/caveat/500.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import 'katex/dist/katex.min.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AgentMap from './screens/AgentMap.jsx';
import ErrorBoundary, { recordError } from './ui/ErrorBoundary.jsx';

window.addEventListener('error', (event) => recordError('error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => recordError('rejection', event.reason));

// The Agent map's window (src/main/agent-map/window.cjs) loads this page at ?view=agent-map: read once, here.
const view = new URLSearchParams(window.location.search).get('view');

createRoot(document.getElementById('root')).render(<ErrorBoundary>{view === 'agent-map' ? <AgentMap /> : <App />}</ErrorBoundary>);

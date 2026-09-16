import '@xterm/xterm/css/xterm.css';
import '@fontsource/caveat/400.css';
import '@fontsource/caveat/500.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary, { recordError } from './ui/ErrorBoundary.jsx';

window.addEventListener('error', (event) => recordError('error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => recordError('rejection', event.reason));

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);

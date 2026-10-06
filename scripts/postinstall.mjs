// npm install's last step (2026-10-05, docs/windows-port.md): node-pty rebuilt for Electron (`npm run rebuild`), as it
// always was, except on Windows. There node-pty's prebuilt modules (node_modules/node-pty/prebuilds/win32-*, N-API, so
// Electron loads them as they are) are used, and a rebuild would need Visual Studio's C++ tools.

import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') process.exit(0);
const { status, signal } = spawnSync('npm', ['run', 'rebuild'], { stdio: 'inherit' });
process.exit(status ?? (signal ? 1 : 0));

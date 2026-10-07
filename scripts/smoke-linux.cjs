'use strict';

// node scripts/smoke-linux.cjs [path/to/engelbart-launch]     (default: release/linux-unpacked/engelbart-launch)
// The packaged Linux app, started (2026-10-07, docs/windows-port-log.md "Linux"; CI runs it under xvfb after building
// the AppImage, and on the copy the install command put in ~/.local/share/engelbart). The same steps as
// scripts/smoke-windows.cjs, which it runs: the window loads, a terminal (bash) echoes a line, the tool check finds Git
// through the login shell, the app quits cleanly; and it says whether Chromium's sandbox is on (SMOKE_SANDBOX=on or off
// to require one).

if (process.platform !== 'linux') { console.error('smoke-linux runs on Linux.'); process.exit(1); }
require('./smoke-windows.cjs');

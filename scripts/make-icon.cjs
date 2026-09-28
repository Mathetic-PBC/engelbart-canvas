'use strict';

// The app icon (2026-09-28), drawn by Chromium and saved as build/icon.png (1024 px) and build/icon.icns, which
// electron-builder.config.cjs uses. A placeholder in the design system's terms (design/goal-canvas/_ds: one ink, greys,
// the blue only for a caret): the letter E on a white macOS icon shape, with a text cursor after it. Change ICON below
// and run it again:
//
//   npx electron scripts/make-icon.cjs

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const BUILD = path.join(__dirname, '..', 'build');

// Apple's icon grid: an 824 px rounded square centred on 1024, radius about 185, a soft shadow beneath it.
const ICON = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .tile { position: absolute; left: 100px; top: 92px; width: 824px; height: 824px; border-radius: 185px; box-sizing: border-box;
    background: linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%); border: 3px solid #e2e2e2;
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.16), 0 2px 5px rgba(0, 0, 0, 0.08);
    display: flex; align-items: center; justify-content: center; }
  .word { display: flex; align-items: center; gap: 26px; transform: translateX(-17px); }
  .e { font: 500 540px/1 system-ui, -apple-system, sans-serif; letter-spacing: -8px; color: #171717; margin-top: -30px; }
  .caret { width: 30px; height: 430px; border-radius: 15px; background: #0070f3; }
</style></head><body><div class="tile"><div class="word"><span class="e">E</span><span class="caret"></span></div></div></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ICON)}`);
  await new Promise((resolve) => setTimeout(resolve, 400)); // fonts
  let image = await win.webContents.capturePage();
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.mkdirSync(BUILD, { recursive: true });
  const png = path.join(BUILD, 'icon.png');
  fs.writeFileSync(png, image.toPNG());
  const set = path.join(BUILD, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('build/icon.png, build/icon.icns');
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });

'use strict';

// The app icon, drawn by Chromium and saved as build/icon.png (1024 px) and build/icon.icns, which
// electron-builder.config.cjs uses. Since 2026-09-29 it is Hudson's artwork (a serif E lit green and blue on black,
// square and full bleed), kept as design/assets/app-icon.png and set in macOS's icon shape; before, a placeholder E with a
// blue caret. Given a path, that image (any square picture) becomes the artwork first:
//
//   npx electron scripts/make-icon.cjs [path/to/artwork.png]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const BUILD = path.join(__dirname, '..', 'build');
const ART = path.join(__dirname, '..', 'design', 'assets', 'app-icon.png');
const given = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
if (given) execFileSync('sips', ['-s', 'format', 'png', path.resolve(given), '--out', ART], { stdio: 'ignore' });
if (!fs.existsSync(ART)) { console.error(`No artwork at ${ART}: give its path, npx electron scripts/make-icon.cjs <artwork.png>`); process.exit(1); }
const art = `data:image/png;base64,${fs.readFileSync(ART).toString('base64')}`;

// Apple's icon grid: an 824 px rounded square centred on 1024, radius about 185, a soft shadow beneath it.
const ICON = `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .tile { position: absolute; left: 100px; top: 92px; width: 824px; height: 824px; border-radius: 185px; overflow: hidden;
    background: #000 url("${art}") center / cover no-repeat;
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.22), 0 2px 5px rgba(0, 0, 0, 0.12); }
</style></head><body><div class="tile"></div></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ICON)}`);
  await new Promise((resolve) => setTimeout(resolve, 400)); // the artwork decoded and drawn
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

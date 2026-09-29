'use strict';
const path = require('node:path');
const { readJson, writeJson } = require('./store/home.cjs');
function windowOptions(saved, areas) {
  const bounds = saved?.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) || bounds.width < 100 || bounds.height < 100 || !areas.length) return { width: 1440, height: 900 };
  const overlap = area => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const area = [...areas].sort((a, b) => overlap(b) - overlap(a))[0];
  const width = Math.max(900, Math.min(Math.round(bounds.width), area.width));
  const height = Math.max(560, Math.min(Math.round(bounds.height), area.height));
  return { width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) };
}
function createWindowState(directory) {
  const file = path.join(directory, 'window-state.json');
  let timer = null;
  const read = () => readJson(file, {});
  const save = window => {
    clearTimeout(timer); timer = null;
    if (!window || window.isDestroyed()) return;
    writeJson(file, { version: 1, bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullscreen: window.isFullScreen() });
  };
  return { read, save, watch(window) {
    const later = () => { clearTimeout(timer); timer = setTimeout(() => save(window), 250); };
    for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) window.on(event, later);
    window.on('close', () => save(window));
  } };
}
module.exports = { windowOptions, createWindowState };

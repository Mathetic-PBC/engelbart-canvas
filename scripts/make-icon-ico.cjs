'use strict';

// The Windows icon, build/icon.ico (2026-10-05, docs/windows-port.md): Hudson's artwork (design/assets/app-icon.png)
// square and full bleed, as Windows shows icons, at the sizes Windows asks for, each stored as a PNG inside the .ico.
// scripts/make-icon.cjs writes it with the Mac's icons; on its own:
//
//   node scripts/make-icon-ico.cjs [path/to/artwork.png]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** `source` (a square picture) as an .ico at `out`, resized with sips. */
function writeIco(source, out) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-ico-'));
  try {
    const images = SIZES.map((size) => {
      const png = path.join(folder, `${size}.png`);
      execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', png], { stdio: 'ignore' });
      return { size, data: fs.readFileSync(png) };
    });
    // ICONDIR, then one ICONDIRENTRY per image (a width or height of 256 is written as 0), then the images.
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, data }, index) => {
      const at = 6 + 16 * index;
      header.writeUInt8(size >= 256 ? 0 : size, at);
      header.writeUInt8(size >= 256 ? 0 : size, at + 1);
      header.writeUInt16LE(1, at + 4); // colour planes
      header.writeUInt16LE(32, at + 6); // bits per pixel
      header.writeUInt32LE(data.length, at + 8);
      header.writeUInt32LE(offset, at + 12);
      offset += data.length;
    });
    fs.writeFileSync(out, Buffer.concat([header, ...images.map(({ data }) => data)]));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

module.exports = { writeIco };

if (require.main === module) {
  const art = path.resolve(process.argv[2] || path.join(__dirname, '..', 'design', 'assets', 'app-icon.png'));
  writeIco(art, path.join(__dirname, '..', 'build', 'icon.ico'));
  console.log('build/icon.ico');
}

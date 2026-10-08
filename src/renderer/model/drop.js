// What is dragged onto the library or a workspace from Finder, Chrome or Safari (MATH-19, 2026-10-05). The home page's
// library, the workspace sidebar's and the document read a drop with readDrop, inside the drop event (its data is gone
// once the event is over), and hand what it found to addDropped, which makes each thing a library row in the main
// process: a file with a path is linked where it is, bytes without one are kept as a copy, a link is read there first.

const HTTP = /^https?:\/\//i;
// The pictures the library keeps a copy of (main/store/library.cjs addFileCopy), as a data: address spells one.
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;
const MAX_DATA_CHARS = 28 * 1024 * 1024; // about 20 MB once decoded, the library's cap for a picture
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const typesOf = (dataTransfer) => [...((dataTransfer && dataTransfer.types) || [])];

/** Whether a drag carries something the library can take: files, or a link. */
export function carriesDrop(event) {
  const types = typesOf(event && event.dataTransfer);
  return types.includes('Files') || types.includes('text/uri-list');
}

function read(dataTransfer, type) {
  try { return String(dataTransfer.getData(type) || ''); } catch { return ''; }
}

const decodeEntities = (value) => value
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

/** The src of the first <img> in a drag's html; '' when there is none. */
export function firstImageSource(html) {
  const tag = String(html || '').match(/<img\b[^>]*>/i);
  const src = tag && tag[0].match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  return src ? decodeEntities((src[1] ?? src[2] ?? src[3]).trim()) : '';
}

/** A Google Images result dragged by its link is the picture it leads to (`/imgres?imgurl=…`); any other link is itself. */
function pictureBehind(url) {
  try {
    const u = new URL(url);
    const wrapped = /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/imgres' ? u.searchParams.get('imgurl') : '';
    return wrapped && HTTP.test(wrapped) ? wrapped : url;
  } catch { return url; }
}

/** A picture spelled as a data: address (a thumbnail in a page of results), as a File; null for anything else. */
function dataImage(value) {
  if (!value || value.length > MAX_DATA_CHARS) return null;
  const match = value.match(DATA_IMAGE);
  if (!match || typeof File !== 'function' || typeof atob !== 'function') return null;
  try {
    const text = atob(match[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
    return new File([bytes], '', { type: match[1].toLowerCase() }); // no name of its own: the library calls it "Image"
  } catch { return null; }
}

/**
 * What a drop holds, read synchronously inside the drop event: [{ kind: 'path', path } | { kind: 'bytes', file } |
 * { kind: 'url', url }]. Files come first and alone: each one `pathForFile` (preload's webUtils.getPathForFile) finds
 * on disk is a path, any other its bytes. With no files, one link: the first http(s) line of text/uri-list, else the
 * src of the first <img> in text/html. A Google Images result's link is the picture behind it; a picture that is only
 * a data: address (a thumbnail) comes as its bytes. Nothing the library could take is [].
 */
export function readDrop(dataTransfer, pathForFile) {
  if (!dataTransfer) return [];
  const files = [...(dataTransfer.files || [])];
  if (files.length) {
    return files.map((file) => {
      let where = null;
      try { where = pathForFile ? pathForFile(file) : null; } catch { where = null; }
      return where ? { kind: 'path', path: where } : { kind: 'bytes', file };
    });
  }
  const lines = read(dataTransfer, 'text/uri-list').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const link = lines.find((line) => HTTP.test(line));
  if (link) return [{ kind: 'url', url: pictureBehind(link) }];
  const src = firstImageSource(read(dataTransfer, 'text/html'));
  if (HTTP.test(src)) return [{ kind: 'url', url: src }];
  const picture = dataImage(lines[0]) || dataImage(src);
  return picture ? [{ kind: 'bytes', file: picture }] : [];
}

/** A picture the document takes as a pasted one (png, jpeg, gif or webp): bytes of that type, or a path that ends so. */
export function isPastable(item) {
  if (!item) return false;
  if (item.kind === 'bytes') return /^image\/(png|jpeg|gif|webp)$/.test(item.file && item.file.type);
  return item.kind === 'path' && /\.(png|jpe?g|gif|webp)$/i.test(item.path);
}

/**
 * Each dropped thing made a library row, one at a time and in order: a path by `api.addLibraryItem`, bytes by
 * `api.addLibraryFile`, a link by `api.addLibraryUrl`. → { rows, problems }: the rows made, and what each refusal said
 * (`errorMessage`, api.js's).
 */
export async function addDropped(items, { api, errorMessage = (error) => String((error && error.message) || error) }) {
  const rows = [];
  const problems = [];
  for (const item of items || []) {
    try {
      if (item.kind === 'path') rows.push(await api.addLibraryItem(item.path));
      else if (item.kind === 'bytes') rows.push(await api.addLibraryFile(new Uint8Array(await item.file.arrayBuffer()), { mime: item.file.type || '', name: item.file.name || null }));
      else if (item.kind === 'url') rows.push(await api.addLibraryUrl(item.url));
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }
  return { rows, problems };
}

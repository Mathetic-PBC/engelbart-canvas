// What a Zotero item's chip does with main's answer to zotero-open (src/main/zotero/mirror.cjs openTarget; MATH-65 build 3):
// a pdf (the item's own, or a free copy found through OpenAlex) opens in the Stage's paper viewer, where highlights and
// notes work as on a library pdf; an item with no pdf opens its DOI's page or its URL in the default browser, never in
// the Stage, where publishers' bot checks block it. → { pdf: path } | { external: url } | { error }
export function zoteroChipAction(target, name = '') {
  if (target && typeof target.path === 'string' && target.path) return { pdf: target.path };
  if (target && typeof target.url === 'string' && /^https?:\/\//i.test(target.url)) return { external: target.url };
  return { error: (target && target.error) || `"${name || 'This item'}" could not be opened` };
}

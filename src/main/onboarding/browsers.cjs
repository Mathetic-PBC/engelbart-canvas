'use strict';

// The browser whose sign-ins Engelbart uses (2026-10-13, the workspace: "Keychain should be from their default browser,
// and they should be able to select a different browser if they need to. The only other browsers that should be options
// are ones that are installed. We need some background process to check what they have downloaded"). Of the supported
// browsers (shared/import-flow.cjs BROWSERS) only installed ones are listed, the default first; which are installed is
// asked in the background (../browser/installed-apps.cjs: /Applications first, then Spotlight, never blocking), once when
// Engelbart starts and again whenever the import flow opens. The person's pick is remembered (./prefs.cjs `browser`) and
// is what ../connect/web-signin.cjs reads first and opens sign-in pages in, in place of the default.

const { BROWSERS, browserById, browserIdOfName, orderBrowsers } = require('../../shared/import-flow.cjs');

const SETTLE_MS = 2500;

/**
 * `installedApps` (../browser/installed-apps.cjs); `defaultName()` macOS's name for the default browser; `prefs` { get, set }.
 * `override` ids standing in for this Mac's browsers (ENGELBART_ONBOARDING_BROWSERS in scripted runs) with the first the
 * default.
 */
function createBrowsers({ installedApps, defaultName = () => '', prefs, override = null }) {
  let last = null;

  const defaultId = () => (override ? override[0] || null : browserIdOfName(defaultName()));

  /** Every supported browser looked for (Spotlight in the background) → the installed ones' ids. */
  async function installed() {
    if (override) return override.filter((id) => browserById(id));
    try { await Promise.race([installedApps.ask(BROWSERS.map((browser) => browser.bundle)), new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); })]); } catch { /* answered as installed */ }
    const out = [];
    for (const browser of BROWSERS) {
      let yes = false;
      try { yes = await installedApps.settled(browser.bundle, { maxMs: SETTLE_MS }); } catch { yes = false; }
      if (yes) out.push(browser.id);
    }
    return out;
  }

  /**
   * → { browsers: [{ id, name, keychain, isDefault }], defaultId, chosenId, keychain } in the order to show them, the
   * default first. `chosenId`: the remembered pick when it is still installed, else the default (when installed), else
   * the first.
   */
  async function list() {
    const ids = orderBrowsers(await installed(), defaultId());
    const remembered = (prefs.get() || {}).browser || null;
    const chosenId = remembered && ids.includes(remembered) ? remembered : ids[0] || null;
    last = { ids, chosenId, defaultId: defaultId() };
    return {
      browsers: ids.map((id) => ({ ...browserById(id), isDefault: id === defaultId() })),
      defaultId: defaultId(),
      chosenId,
      keychain: (prefs.get() || {}).keychain || null,
    };
  }

  /** The person picked `id` ("Use another browser"): remembered when it is installed. */
  async function choose(id) {
    if (!browserById(id)) throw new TypeError('browser is invalid');
    const ids = last ? last.ids : (await list()).browsers.map((browser) => browser.id);
    if (!ids.includes(id)) throw new Error(`${browserById(id).name} is not installed`);
    prefs.set({ browser: id });
    return list();
  }

  /** The answer to "Allow Engelbart to use your <browser> sign-ins?" */
  function setKeychain(answer) {
    if (answer !== 'allowed' && answer !== 'declined') throw new TypeError('answer is invalid');
    prefs.set({ keychain: answer });
    return answer;
  }

  /**
   * The name ../connect/web-signin.cjs should treat as the default browser: the remembered pick (by name, as macOS names
   * the default), else macOS's default. Synchronous: it is asked on every sign-in.
   */
  function preferredName() {
    const remembered = (prefs.get() || {}).browser || null;
    if (remembered) return browserById(remembered).name;
    return defaultName();
  }

  return { list, choose, setKeychain, preferredName, defaultId };
}

module.exports = { createBrowsers };

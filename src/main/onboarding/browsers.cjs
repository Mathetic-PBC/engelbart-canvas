'use strict';

// The browser whose sign-ins Engelbart uses (2026-10-13, the workspace: "Keychain should be from their default browser,
// and they should be able to select a different browser if they need to. The only other browsers that should be options
// are ones that are installed. We need some background process to check what they have downloaded"). Of the supported
// browsers (shared/import-flow.cjs BROWSERS) only installed ones are listed, the default first; which are installed is
// asked in the background (../browser/installed-apps.cjs: /Applications first, then Spotlight, never blocking), once when
// Engelbart starts and again whenever the import flow opens. The person's pick is remembered (./prefs.cjs `browser`) and
// is what ../connect/web-signin.cjs reads first and opens sign-in pages in, in place of the default.
//
// Its profile (2026-10-16, C4, the Onboarding note: "When importing from a browser that has multiple profiles, a popup should
// appear asking the user to select which profile (one selection only)"): each browser's profiles come with the list
// (`profilesOf`, ../connect/web-signin.cjs: Chromium's Local State names and accounts, Firefox's profiles.ini, Safari's
// profiles once Full Disk Access is granted), and the one picked is remembered with the browser (./prefs.cjs `profile`):
// the only profile any copy reads. Allow (C5, S12) asks macOS for that browser's sign-ins at once (`unlock`), so the prompt
// comes while the person is looking at what it is for; Safari has no Keychain prompt, and its Allow means Full Disk Access.

const { BROWSERS, browserById, browserIdOfName, orderBrowsers } = require('../../shared/import-flow.cjs');

const SETTLE_MS = 2500;

// Off the Mac (2026-10-18, the beta's Windows catch-up, docs/windows-port-log.md): no browser's sign-ins are copied there
// (Chrome's cookies on Windows are app-bound; windows-port's decision: every sign-in goes through Engelbart's own window),
// so "Allow Engelbart to use your … sign-ins" has nothing to ask. It counts as answered ('allowed': the run uses sign-ins,
// made in Engelbart's window) and macOS's unlock is never called. Safari is the Mac's alone. The installed browsers are
// still listed: the tools screen reads the chosen one's history.
const copiesSignIns = (platform) => platform === 'darwin';

/**
 * `installedApps` (../browser/installed-apps.cjs); `defaultName()` macOS's name for the default browser; `prefs` { get, set }.
 * `override` ids standing in for this Mac's browsers (ENGELBART_ONBOARDING_BROWSERS in scripted runs) with the first the
 * default. `profilesOf(id)` → [{ id, name, email }] a browser's profiles ([] for one or none readable); `unlock(id)` →
 * { keychain: 'allowed' } | { keychain: 'refused', browser } once macOS answered (webSignIn.unlockBrowser);
 * `diskAccess()` → { granted } (./disk-access.cjs status).
 */
function createBrowsers({ installedApps, defaultName = () => '', prefs, override = null, profilesOf = () => [], unlock = null, diskAccess = null, platform = process.platform }) {
  let last = null;

  const defaultId = () => (override ? override[0] || null : browserIdOfName(defaultName()));

  /** Every supported browser looked for (Spotlight in the background) → the installed ones' ids. */
  async function installed() {
    if (override) return override.filter((id) => browserById(id));
    try { await Promise.race([installedApps.ask(BROWSERS.map((browser) => browser.bundle)), new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); })]); } catch { /* answered as installed */ }
    const out = [];
    for (const browser of BROWSERS) {
      if (browser.id === 'safari' && platform !== 'darwin') continue;
      let yes = false;
      try { yes = await installedApps.settled(browser.bundle, { maxMs: SETTLE_MS }); } catch { yes = false; }
      if (yes) out.push(browser.id);
    }
    return out;
  }

  const profiles = (id) => { try { return (profilesOf(id) || []).map(({ id: pid, name, email }) => ({ id: String(pid), name: String(name || pid), email: String(email || '') })); } catch { return []; } };
  const granted = async () => { if (!diskAccess) return false; try { return !!(await diskAccess()).granted; } catch { return false; } };

  /**
   * → { browsers: [{ id, name, keychain, isDefault, profiles: [{ id, name, email }] }], defaultId, chosenId, chosenProfile,
   * keychain, safari: { diskAccess } } in the order to show them, the default first. `chosenId`: the remembered pick when it
   * is still installed, else the default (when installed), else the first. `chosenProfile`: the remembered profile when it
   * is one of the chosen browser's, else null (the popup asks when there are several). `profiles` is [] for a browser with
   * one profile or none readable.
   */
  async function list() {
    const ids = orderBrowsers(await installed(), defaultId());
    const remembered = prefs.get() || {};
    const chosenId = remembered.browser && ids.includes(remembered.browser) ? remembered.browser : ids[0] || null;
    last = { ids, chosenId, defaultId: defaultId() };
    const browsers = ids.map((id) => ({ ...browserById(id), isDefault: id === defaultId(), profiles: profiles(id) }));
    const chosen = browsers.find((browser) => browser.id === chosenId);
    const chosenProfile = chosen && remembered.profile && (!remembered.browser || remembered.browser === chosenId) && chosen.profiles.some((profile) => profile.id === remembered.profile) ? remembered.profile : null;
    return {
      browsers,
      defaultId: defaultId(),
      chosenId,
      chosenProfile,
      keychain: copiesSignIns(platform) ? remembered.keychain || null : 'allowed',
      safari: { diskAccess: await granted() },
    };
  }

  /** The person picked `id` ("Use another browser"): remembered when it is installed; another browser's profile forgotten. */
  async function choose(id) {
    if (!browserById(id)) throw new TypeError('browser is invalid');
    const ids = last ? last.ids : (await list()).browsers.map((browser) => browser.id);
    if (!ids.includes(id)) throw new Error(`${browserById(id).name} is not installed`);
    const was = prefs.get() || {};
    prefs.set({ browser: id, ...(was.browser !== id ? { profile: null } : {}) });
    return list();
  }

  /**
   * "Select your {browser} profile" (S10): `profileId` of `browserId`, remembered with the browser → the same as list().
   * A profile the browser doesn't have is refused.
   */
  async function chooseProfile(browserId, profileId) {
    if (!browserById(browserId)) throw new TypeError('browser is invalid');
    const ids = last ? last.ids : (await list()).browsers.map((browser) => browser.id);
    if (!ids.includes(browserId)) throw new Error(`${browserById(browserId).name} is not installed`);
    if (!profiles(browserId).some((profile) => profile.id === profileId)) throw new Error(`${browserById(browserId).name} has no such profile`);
    prefs.set({ browser: browserId, profile: profileId });
    return list();
  }

  /**
   * The answer to "Allow Engelbart to use your <browser> sign-ins?" (C5, S11, S12), remembered → { keychain: 'declined' }
   * at once (macOS never asked), or, allowed, once macOS answered for the chosen browser: { keychain: 'allowed' } |
   * { keychain: 'refused', browser } (one prompt, its key kept for the run). Safari: allowed when Full Disk Access is
   * granted and its file reads.
   */
  async function setKeychain(answer) {
    if (answer !== 'allowed' && answer !== 'declined') throw new TypeError('answer is invalid');
    if (!copiesSignIns(platform)) return { keychain: 'allowed' };
    prefs.set({ keychain: answer });
    if (answer === 'declined' || typeof unlock !== 'function') return { keychain: answer };
    const remembered = (prefs.get() || {}).browser || null;
    const id = remembered || (last && last.chosenId) || defaultId();
    if (!id) return { keychain: 'allowed' };
    try {
      const out = await unlock(id);
      return out && out.keychain === 'refused' ? { keychain: 'refused', browser: out.browser || browserById(id)?.name || '', ...(out.needs ? { needs: out.needs } : {}) } : { keychain: 'allowed' };
    } catch {
      return { keychain: 'allowed' }; // nothing macOS could be asked: the copy says what it finds
    }
  }

  /**
   * The name ../connect/web-signin.cjs should treat as the default browser: the remembered pick (by name, as macOS names
   * the default), else macOS's default. Synchronous: it is asked on every sign-in.
   */
  function preferredName() {
    const remembered = (prefs.get() || {}).browser || null;
    if (remembered) return browserById(remembered).name;
    // The one the flow showed ("Allow Engelbart to use your Arc sign-ins?"), so a sign-in popup names the same browser.
    if (last && last.chosenId && browserById(last.chosenId)) return browserById(last.chosenId).name;
    return defaultName();
  }

  return { list, choose, chooseProfile, setKeychain, preferredName, defaultId };
}

module.exports = { createBrowsers, copiesSignIns };

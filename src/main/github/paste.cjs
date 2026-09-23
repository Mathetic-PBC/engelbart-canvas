'use strict';

// Fill only GitHub's device-code inputs. Never submit, fill a password/2FA field, or paste
// into whatever happens to have focus. The in-page origin check also covers navigation races.
async function pasteDeviceCode(contents, pending, web = 'https://github.com') {
  if (!pending || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pending.userCode || '')) throw new Error('No valid GitHub sign-in code');
  if (!contents || contents.isDestroyed()) return false;
  const expected = new URL(pending.verificationUri);
  if (expected.origin !== new URL(web).origin || expected.pathname !== '/login/device') return false;
  const matches = (value) => {
    try { const url = new URL(value); return url.origin === expected.origin && url.pathname === expected.pathname; } catch { return false; }
  };
  if (!matches(contents.getURL())) return false;
  const args = { origin: expected.origin, pathname: expected.pathname, code: pending.userCode.replace('-', '') };
  const fill = ({ origin, pathname, code }) => {
    if (location.origin !== origin || location.pathname !== pathname) return false;
    const fields = [0, 1, 2, 3, 5, 6, 7, 8].map((i) => document.getElementById(`user-code-${i}`));
    if (fields.some((field) => !(field instanceof HTMLInputElement) || field.type !== 'text' || field.maxLength !== 1 || field.disabled || field.readOnly || !field.getClientRects().length)) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    fields.forEach((field, i) => {
      set.call(field, code[i]);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fields[7].focus();
    return true;
  };
  const filled = await contents.executeJavaScript(`(${fill.toString()})(${JSON.stringify(args)})`, true);
  if (filled) contents.focus();
  return filled === true;
}

module.exports = { pasteDeviceCode };

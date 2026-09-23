# The GitHub App behind "Add from GitHub…"

Engelbart signs in to GitHub through a **GitHub App owned by Mathetic-PBC**, using GitHub's **device flow**
(`src/main/github/connection.cjs`). The app on the desktop holds only the App's **client ID**, which is public. It
never holds a client secret: the device flow needs none, neither for the first token nor for refreshing it (GitHub:
`client_secret` is "Required unless the user access token was generated using the device flow").

Why a GitHub App and not an OAuth App: an OAuth App's only scope that reads private repositories is `repo`, which is
read *and write* to every repository the person can reach. A GitHub App asks for **Contents: Read-only** and reads only
where it is installed.

## 1. Register the App (an owner of Mathetic-PBC does this once)

github.com → your picture → **Your organizations** → Mathetic-PBC → **Settings** → **Developer settings** →
**GitHub Apps** → **New GitHub App**.

| Field | Value |
|---|---|
| GitHub App name | `Engelbart` (unique across GitHub, 34 characters at most; `Engelbart by Mathetic` if taken) |
| Homepage URL | the Mathetic or Engelbart site (any full URL) |
| Callback URL | leave empty (the device flow does not use one) |
| Expire user authorization tokens | **keep checked** (8-hour tokens, 6-month refresh tokens; Engelbart refreshes them itself) |
| Request user authorization (OAuth) during installation | unchecked |
| **Enable Device Flow** | **checked** (without it GitHub answers `device_flow_disabled`) |
| Setup URL | empty |
| Webhook → Active | **unchecked** (Engelbart has no server to receive events) |
| Repository permissions → **Contents** | **Read-only** |
| Repository permissions → Metadata | Read-only (GitHub sets this itself) |
| Everything else | No access |
| Where can this GitHub App be installed? | **Any account** if people outside Mathetic-PBC will use Engelbart with their own repositories; **Only on this account** while it is only for Mathetic-PBC |

**Create GitHub App.** On the page that follows, copy the **Client ID** (it starts `Iv23li…`; it is *not* the numeric
App ID). Do **not** generate a client secret or a private key: nothing here uses them, and a secret that is never
made can never leak.

The App's page address ends in its **slug**: `github.com/apps/<slug>` (for the name `Engelbart`, the slug is
`engelbart`).

## 2. Install it on Mathetic-PBC

On the App's settings page → **Install App** → Mathetic-PBC → **All repositories** (or only the ones Engelbart
should see) → **Install**. A person's own repositories appear once they install it on their own account too:
the GitHub view in Engelbart has **Install on an account…** for that.

What a signed-in person sees is the intersection of what *they* can read and where the App is installed.

## 3. Bundled registration (no user configuration)

Engelbart ships with the public **Engelbart Mathetic** registration owned by Mathetic-PBC:

```json
"github": {
  "clientId": "Iv23liAZNYl96zlluMDs",
  "appSlug": "engelbart-mathetic"
}
```

These public identifiers are the `GITHUB_DEFAULTS` in `src/main/store/home.cjs`. Fresh installs and older
configs with an absent or empty `github` block use them automatically. Users do not create a GitHub App
or visit Developer Settings: they sign in and install Engelbart on the accounts/repositories they choose.
The shared registration must allow **Any account** to install it. Its installation page is
https://github.com/apps/engelbart-mathetic/installations/new.

`~/.engelbart/config.json` can still override both identifiers for a separate registration; it is read
again on every use. Never bundle access tokens, refresh tokens, client secrets, or private keys.

## 4. Sign in

In a workspace: the sidebar's **+** → **Add from GitHub…**. A code appears (already on the clipboard) and a small
window opens on github.com/login/device. That window shares the Browser pane's cookies, so if you are signed in to
GitHub there you only paste the code and press **Authorize**. **Browser** does the same in your default browser
instead: use it if you sign in to GitHub with a passkey kept on this Mac (Touch ID), which the unsigned build cannot offer. The window closes
itself when GitHub says yes, and the list of repositories appears.

The token is kept in `~/.engelbart/github.json`, encrypted by the macOS keychain (Electron `safeStorage`); it is
not readable as text. **Sign out** deletes it. To revoke Engelbart's access entirely: github.com → Settings →
Applications → **Authorized GitHub Apps** → Engelbart → Revoke.

## What the connection is used for

- **Add from GitHub…**: the repositories the App can read, newest push first, searchable; a lock marks a private
  one; picking one adds it to the library (or brings the library's row for it into the workspace).
- **Adding any GitHub address** (the + field, the search, Save in the Browser): the repository's GitHub id, name and
  description are now read signed in, so a private repository (such as `Mathetic-PBC/engelbart-canvas`) gets its id
  too instead of falling back to its address.
- **Hovering a repository with no clone**: its top-level files, for private repositories too.

## Testing without GitHub

`ENGELBART_GITHUB_WEB=http://127.0.0.1:<port>` (with `ENGELBART_GITHUB_CLIENT_ID` and `ENGELBART_GITHUB_APP_SLUG`)
points the sign-in at a fake GitHub that answers `/login/device/code`, `/login/oauth/access_token`, `/user`,
`/user/installations` and `/user/installations/<id>/repositories`. For scripted runs only.

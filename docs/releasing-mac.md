# Releasing Engelbart for the Mac

How a version of Engelbart gets from this repository onto other people's Macs (2026-09-28). The pieces:
`electron-builder.config.cjs` (what goes into the app), `scripts/package-mac.mjs` (`npm run package`, `npm run dist:mac`),
`scripts/fetch-git.mjs` (the Git inside the app), `scripts/install-mac.sh` (the install command),
`scripts/release-site.mjs` (the folder to upload) and `src/main/updates.cjs` (how an installed app finds a new version).

## Once

- `npm install` (it brings electron-builder and electron-updater).
- A folder on the web, served over HTTPS, for the release files: any static host, an S3 or R2 bucket, a folder on your
  site. The repository can stay private; only this folder is public. Its address is `ENGELBART_DOWNLOAD_URL` below and
  is built into every app made for it, so keep it stable.

## Every release

1. Raise `version` in `package.json` (0.1.0 → 0.1.1). An installed app only updates to a higher version.
2. Commit what goes in. A release is built from the working folder, so anything uncommitted goes in too (the script
   lists it). Tag the commit (`git tag v0.1.1`) to find it again.
3. Build both kinds of Mac:

   ```sh
   ENGELBART_DOWNLOAD_URL=https://mathetic.com/engelbart npm run dist:mac
   ```

   From a checkout with its own `node_modules`, installed with `npm ci`: never a symlink to another checkout's, which
   made electron-builder leave 35 packages out of 0.1.2 (E2B Builds and update checks failed in the installed app). The
   script refuses a symlinked `node_modules`, and every app it packs is checked for every package its main process
   needs (`scripts/check-app-modules.cjs`, also `node scripts/check-app-modules.cjs /Applications/Engelbart.app`).

   About a minute. It builds the renderer for production (minified, no source maps), minifies the main process file by
   file, fetches Git for both architectures (cached in `vendor/git` after the first time), and makes
   `Engelbart-<version>-arm64` (Apple silicon) and `-x64` (Intel), each as a `.dmg` and a `.zip`, about 155 MB each.
4. Upload it: `npm run upload:mac` (`scripts/upload-release.sh`; `UPLOAD_DRY_RUN=1` first lists what it would send).
   It uses your `npx wrangler login` and puts everything in `release/upload/` into the R2 bucket `engelbart-releases`
   under `engelbart/`, which https://mathetic.com/engelbart/ serves:

   ```
   Engelbart-0.1.1-arm64.dmg   Engelbart-0.1.1-arm64.zip   Engelbart-0.1.1-arm64.zip.blockmap
   Engelbart-0.1.1-x64.dmg     Engelbart-0.1.1-x64.zip     Engelbart-0.1.1-x64.zip.blockmap
   latest-mac.yml              install.sh                  index.html      SHA256SUMS.txt
   ```

   Every file goes up in 5 MiB parts, each retried on its own, through a temporary Worker it deploys and deletes: on
   2026-09-30 this Mac's uploads to Cloudflare broke a few MB in, and a single 168 MB upload never got through. It can
   be run again after any failure (what is already there is skipped). `latest-mac.yml` goes last, and only once both
   zips as stored match the sha512 it names: it is what tells installed apps and the install command that a version
   exists, so until then the previous version stays live. Older versions' files can be deleted.
5. Send people the page (`index.html`, the folder's address) or the command:

   ```sh
   curl -fsSL https://mathetic.com/engelbart | bash
   ```

## What people see

**The install command** (recommended). Paste into Terminal, press Return. It picks the build for their Mac, checks it
against the checksum in `latest-mac.yml`, puts Engelbart in `/Applications` (`~/Applications` on an account that cannot
write there) and opens it. A file curl downloaded is not marked as coming from the internet, so macOS opens the app
without the Gatekeeper warning. Running the command again updates Engelbart in place. It needs macOS 13 or later
(Electron 44's minimum).
When the newest version is already installed, the command says so and exits without downloading or changing anything
(`ENGELBART_FORCE=1` reinstalls it anyway).

**The .dmg**, while builds are not notarized (see Signing): the first open shows **"Engelbart" Not Opened** (Apple could
not verify it is free of malware) with Done and Move to Trash. Done, then System Settings › Privacy & Security, scroll
down, **Open Anyway**, password. After that it opens normally. If a Mac says the app **is damaged**, that is the same
check: `xattr -dr com.apple.quarantine /Applications/Engelbart.app` in Terminal.

**First launch.** A release has no test mode (`src/main/developer.cjs`; their work goes in `~/.engelbart`). It checks for Git, Claude Code
and Codex:

- Git: the one inside the app is used when the Mac has none of its own, so Apple's developer tools installer never
  appears (`src/main/tools/bundled-git.cjs`).
- Claude Code: on a Mac with neither agent it is installed without asking (about 300 MB), and the setup dialog shows it
  installing, then **Sign in**, which opens the browser for their Claude account.
- Codex: **Install** in the same dialog, then a ChatGPT sign-in. **Skip** leaves it out.

Everything a person makes lives outside the app (`~/.engelbart`, `~/Library/Application Support/Engelbart`), so a new
version, or the install command run again, keeps it. That holds as long as `productName` stays `Engelbart` and `appId`
stays `dev.engelbart.desktop`; and every change to how data is stored needs a migration (`src/main/store/migrate.cjs`),
because people's data from this version has to open in the next.

## Updates

An installed app checks the folder a minute after it opens, every six hours, and from **Engelbart ▸ Check for
Updates…**. A new version is offered once per launch:

- **Signed ad hoc** (today): macOS installs an update only when it is signed like the app it replaces, which an ad hoc
  signature never is, so **Update** runs the install command in the background. The app stays open while the new version
  downloads (a banner in each window shows how far it is) and is checked, then asks: **Restart to Update** quits, the
  app is replaced where it is and opens again; **Later** leaves the command waiting for as long as the app stays open,
  and it is installed at the next quit, which opens nothing. Restart to Update from the menu or a banner asks first
  when terminal sessions are running, as any quit does (Cancel is then as Later). If the command was stopped
  meanwhile, Restart to Update downloads it again and then restarts. If anything fails before it is ready, the app says why and stays as it was. The command's output:
  `~/Library/Logs/Engelbart/update.log`.
- **Developer ID** (once signed): electron-updater downloads it in the background and installs it when the app quits;
  **Restart Now** does it at once.

An ad hoc build updates to a signed one the same way it updates to anything (the install command replaces the app),
so nobody should have to reinstall by hand when signing starts; the signed version then updates itself with
electron-updater. That is how it is built, not yet tried with a signed build.

## Signing and notarizing

Without it, the .dmg route shows the warning above; the install command does not. To remove the warning:

1. Join the Apple Developer Program ($99 a year; as an individual it is usually quick, as a company it needs a D-U-N-S
   number).
2. Create a **Developer ID Application** certificate (Xcode › Settings › Accounts, or developer.apple.com) and put it in
   the login keychain, or export it as a .p12 and set `CSC_LINK` (its path or base64) and `CSC_KEY_PASSWORD`.
3. Make an app-specific password at account.apple.com and set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
   `APPLE_TEAM_ID`.
4. `npm run dist:mac` as before. With a Developer ID certificate found, electron-builder signs everything in the app
   (Git's programs too) with the hardened runtime and the entitlements in `build/entitlements.mac.plist`, and
   notarizes it; the app records that it is signed, which switches its updates to electron-updater.
   `ENGELBART_SIGN=adhoc` forces an ad hoc build anyway; `npm run package` always is one.

This is set up but has not been run, because there was no certificate to run it with.

## Checking a build

- `codesign --verify --deep --strict release/mac-arm64/Engelbart.app` (the Intel one is in `release/mac/`).
- What a Mac without Git gets, on one that has it: `ENGELBART_GIT=bundled /Applications/Engelbart.app/Contents/MacOS/Engelbart`
  (Engelbart ▸ Set Up Tools… then shows Git as `2.53.0 · built in`, and `command -v git` in its terminal names the
  app's).
- The install command against a folder on this Mac, without touching `/Applications`:
  `cd release/upload && python3 -m http.server 8767`, then
  `curl -fsSL http://127.0.0.1:8767/install.sh | ENGELBART_DOWNLOADS=http://127.0.0.1:8767/ ENGELBART_INSTALL_DIR=/tmp/try ENGELBART_NO_OPEN=1 bash`.
- The real test: a Mac, or a new macOS user account, that has never run Engelbart (no `~/.engelbart`, no Claude Code,
  no developer tools). Your own Mac hides all three.

## Inside the app

- Electron 44, the renderer (`dist/`), the main process (`src/main`, minified in a release), and only the packages the
  main process loads (node-pty, PGlite, pdf.js's legacy build, electron-updater); the renderer's are already in `dist/`.
- node-pty's prebuilt modules for both architectures, so nothing is compiled for a release.
- `Contents/Resources/git`: Git 2.53.0 from dugite-native (GitHub Desktop's build), with Git LFS, without Git Credential
  Manager (~110 MB nothing uses). To move to a newer one, copy the two macOS entries (URL, checksum) from the npm package
  dugite's `script/embedded-git.json` into `scripts/fetch-git.mjs`.
- Chromium's own strings in English only (`electronLanguages`), as Engelbart's are.
- The icon (`build/icon.icns`) is drawn by `scripts/make-icon.cjs` from the artwork in `design/assets/app-icon.png`, set in
  macOS's rounded icon shape (`npx electron scripts/make-icon.cjs [new-artwork.png]`).

'use strict';

// How Engelbart is packaged for the Mac (2026-09-28; electron-builder). `npm run package` makes the app for this Mac
// only (release/mac-<arch>/Engelbart.app, what `npm run relaunch` opens); `npm run dist:mac` makes a release for
// both kinds of Mac (scripts/package-mac.mjs; how to ship it: docs/releasing-mac.md).
//
// Signing. With a Developer ID Application certificate (named by CSC_LINK / CSC_NAME, or found in the login
// keychain) the app is signed with the hardened runtime and, when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
// APPLE_TEAM_ID are set, notarized: macOS then opens it like any app from the web. Without one it is signed ad hoc,
// which an Apple Silicon Mac needs to run it at all, and a copy downloaded with a browser is stopped by Gatekeeper
// once (the install command, which downloads with curl, is not). ENGELBART_SIGN=adhoc forces the second (the
// everyday `npm run package` sets it, so a rebuild is never sent to Apple).
//
// ENGELBART_DOWNLOAD_URL: the folder on the web a release is uploaded to. The app checks there for new versions
// (src/main/updates.cjs) and the install command downloads from there; without it neither is set up.
// ENGELBART_APP_SOURCE: a folder laid out like src/ holding the main process minified (a release sets it).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch } = require('electron-builder');

function developerId() {
  if (process.env.ENGELBART_SIGN === 'adhoc') return false;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return true;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return false;
  try {
    return /"Developer ID Application: /.test(execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

const signed = developerId();
const source = process.env.ENGELBART_APP_SOURCE || null;
const downloads = process.env.ENGELBART_DOWNLOAD_URL ? `${process.env.ENGELBART_DOWNLOAD_URL.replace(/\/+$/, '')}/` : null;

module.exports = {
  appId: 'dev.engelbart.desktop', // the id every earlier build had: macOS keeps its permissions and settings under it
  productName: 'Engelbart', // names ~/Library/Application Support/Engelbart, where @bart's threads and settings are
  copyright: 'Copyright © 2026 Engelbart',
  directories: { output: 'release', buildResources: 'build' },
  artifactName: 'Engelbart-${version}-${arch}.${ext}',
  // Read by the app (src/main/updates.cjs): where new versions are, and whether it can install them itself.
  extraMetadata: { engelbart: { downloads, developerId: signed } },
  files: [
    'package.json',
    ...(source
      ? [{ from: source, to: 'src', filter: ['main/**/*.cjs', 'shared/**/*.cjs', 'preload.cjs', 'post-it-preload.cjs'] }]
      : ['src/main/**/*.cjs', 'src/shared/**/*.cjs', 'src/preload.cjs', 'src/post-it-preload.cjs']),
    'dist/**/*',
    '!dist/**/*.map',
    'fixtures/**/*', // test mode's seed library
    // electron-builder adds the production dependencies; these are the renderer's, already bundled into dist/.
    '!node_modules/{react,react-dom,scheduler,roughjs,hachure-fill,path-data-parser,points-on-curve,points-on-path}{,/**}',
    '!node_modules/{@xterm,@fontsource}{,/**}',
    // pdf.js: the main process reads text with the legacy build only (src/main/context/pdf-text.cjs).
    '!node_modules/pdfjs-dist/{build,web,types,image_decoders}{,/**}',
    '!node_modules/pdfjs-dist/legacy/{web,image_decoders}{,/**}',
    // …and never draws, so not @napi-rs/canvas, pdf.js's optional drawing module (npm installs it for one architecture).
    '!node_modules/@napi-rs{,/**}',
    '!node_modules/**/*.map',
    // node-pty: its prebuilt modules (N-API, so Electron loads them as they are) for both Macs; no build folder, so
    // node-pty looks in prebuilds/, and no sources or Windows binaries.
    '!node_modules/node-pty/{build,deps,src,third_party,scripts,node-addon-api,binding.gyp}{,/**}',
    '!node_modules/node-pty/prebuilds/win32-*{,/**}',
  ],
  asarUnpack: ['node_modules/node-pty/**', 'node_modules/@electric-sql/pglite/**'],
  npmRebuild: false, // nothing to compile: node-pty's prebuilt modules are used
  electronLanguages: ['en'], // Chromium's own strings in English only, as Engelbart's are (about 45 MB less)
  // Engelbart's own Git for the architecture being built (scripts/fetch-git.mjs; src/main/tools/bundled-git.cjs).
  extraResources: [{ from: 'vendor/git/darwin-${arch}', to: 'git', filter: ['**/*', '!.engelbart-git.json'] }],
  afterPack: (context) => {
    // node-pty's prebuilt spawn-helper comes from npm without its execute bit; without it no terminal starts.
    const unpacked = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
    for (const dir of fs.existsSync(unpacked) ? fs.readdirSync(unpacked) : []) {
      const helper = path.join(unpacked, dir, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
    const git = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'git', 'engelbart-bin', 'git');
    if (!fs.existsSync(git)) throw new Error(`No Git for ${Arch[context.arch]} in the app: run \`node scripts/fetch-git.mjs ${Arch[context.arch]}\` first.`);
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }, // what the install command and updates download
    ],
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: signed,
    // What macOS says when a terminal or an agent in Engelbart first opens one of these folders.
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'Engelbart’s terminals and agents work in the folders you choose.',
      NSDesktopFolderUsageDescription: 'Engelbart’s terminals and agents work in the folders you choose.',
      NSDownloadsFolderUsageDescription: 'Engelbart’s terminals and agents work in the folders you choose.',
      NSRemovableVolumesUsageDescription: 'Engelbart’s terminals and agents work in the folders you choose.',
      NSNetworkVolumesUsageDescription: 'Engelbart’s terminals and agents work in the folders you choose.',
    },
  },
  dmg: {
    title: 'Engelbart ${version}',
    writeUpdateInfo: false, // updates come from the zip
  },
  publish: downloads ? [{ provider: 'generic', url: downloads }] : null,
};

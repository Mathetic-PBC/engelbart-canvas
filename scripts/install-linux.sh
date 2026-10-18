#!/bin/bash
# Installs Engelbart on Linux, or updates it (2026-10-07, docs/windows-port-log.md "Linux"). The Mac's command does it:
#
#   curl -fsSL __DOWNLOADS__install.sh | bash
#
# install.sh (scripts/install-mac.sh) runs this, from the same folder, when `uname -s` says Linux. It reads the newest
# version from __DOWNLOADS__ (latest-linux.yml names the AppImage and gives its checksum), downloads it, checks it, and
# installs it for this account, with no root needed: the AppImage unpacked into ~/.local/share/engelbart/app (unpacked,
# so it runs without FUSE, which Ubuntu 22.04 and later do not install), an `engelbart` command in ~/.local/bin, and an
# entry with its icon in the app menu. Then it opens Engelbart. When that version is already installed it stops without
# downloading (ENGELBART_FORCE=1 installs it again anyway). Projects, notes and settings live outside the app
# (~/.engelbart, ~/.config/Engelbart) and are not touched.
#
# Engelbart needs Git: without one this says how to install it for the distribution, and stops.
#
# Chromium's sandbox: on Ubuntu 23.10 and later (24.04 among them) AppArmor lets a program make user namespaces, which
# the sandbox needs, only when a profile allows it. Where it can use sudo this offers to add one for Engelbart, as
# Chrome's package does (ENGELBART_APPARMOR=yes adds it without asking, =no never), and the sandbox stays on; without one
# Engelbart starts without the sandbox (its launcher, build/linux/engelbart-launch, decides each time it starts). What
# happened is the last thing this prints.
#
# ENGELBART_DOWNLOADS reads from another folder; ENGELBART_INSTALL_DIR installs into another folder;
# ENGELBART_NO_OPEN=1 leaves Engelbart closed afterwards.
set -euo pipefail

DOWNLOADS="${ENGELBART_DOWNLOADS:-__DOWNLOADS__}"
DOWNLOADS="${DOWNLOADS%/}/"
DEST="${ENGELBART_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/engelbart}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

work=""
cleanup() { if [ -n "$work" ]; then rm -rf "$work"; fi; }
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nEngelbart was not installed: %s\n' "$*" >&2
  exit 1
}

# How to install Git here, from /etc/os-release.
git_hint() {
  local id="" like=""
  if [ -r /etc/os-release ]; then id=$(. /etc/os-release && printf '%s' "${ID:-}"); like=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}"); fi
  case " $id $like " in
    *" debian "*|*" ubuntu "*) echo "sudo apt install git" ;;
    *" fedora "*|*" rhel "*|*" centos "*) echo "sudo dnf install git" ;;
    *" arch "*) echo "sudo pacman -S git" ;;
    *" suse "*|*" opensuse "*) echo "sudo zypper install git" ;;
    *) echo "your distribution's package manager (the package is called git)" ;;
  esac
}

# Chromium's sandbox, as the launcher will find it: "on", or "off: <why>". (The same tests as build/linux/engelbart-launch.)
sandbox_state() {
  local bin="$DEST/app/engelbart" profile
  if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" = 0 ]; then echo "off: user namespaces are turned off (user.max_user_namespaces=0)"; return; fi
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then echo "off: user namespaces are turned off (kernel.unprivileged_userns_clone=0)"; return; fi
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    for profile in /etc/apparmor.d/engelbart*; do
      if [ -f "$profile" ] && grep -qF "$bin" "$profile"; then echo "on: the AppArmor profile $profile lets Engelbart make user namespaces"; return; fi
    done
    echo "off: AppArmor lets only programs with a profile make user namespaces, and Engelbart has none"
    return
  fi
  echo "on: this system lets programs make user namespaces"
}

# Asks a yes/no question on the terminal (stdin is this script, under `curl | bash`). No terminal: no.
ask() {
  local answer=""
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 1
  { printf '%s [Y/n] ' "$1" > /dev/tty && read -r answer < /dev/tty; } 2>/dev/null || return 1
  case $answer in ""|y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

# An AppArmor profile that lets Engelbart's binary make user namespaces (unconfined otherwise), as Chrome's package
# installs for Chrome. Asked for (or ENGELBART_APPARMOR=yes) and only with sudo. → whether it was added
apparmor_profile() {
  local bin="$DEST/app/engelbart" text profile
  profile="/etc/apparmor.d/engelbart-$(id -u)"
  case "${ENGELBART_APPARMOR:-ask}" in no) return 1 ;; esac
  command -v sudo >/dev/null || { say "No sudo here to add an AppArmor profile for Engelbart."; return 1; }
  if [ "${ENGELBART_APPARMOR:-ask}" != yes ]; then
    say "Ubuntu's AppArmor keeps Chromium's sandbox from starting unless Engelbart has a profile, which needs sudo."
    ask "Add an AppArmor profile for Engelbart so its sandbox stays on?" || { say "No profile added (ENGELBART_APPARMOR=yes adds one without asking)."; return 1; }
  fi
  text="abi <abi/4.0>,
include <tunables/global>

# Engelbart (installed for user $(id -un) by its install command): may make user namespaces, which Chromium's sandbox needs.
profile engelbart-$(id -u) \"$bin\" flags=(unconfined) {
  userns,

  include if exists <local/engelbart-$(id -u)>
}"
  printf '%s\n' "$text" > "$work/apparmor"
  if sudo install -m 644 "$work/apparmor" "$profile" && sudo apparmor_parser -r "$profile"; then return 0; fi
  sudo rm -f "$profile" 2>/dev/null || true
  say "The AppArmor profile could not be added."
  return 1
}

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux."
machine=$(uname -m)
case $machine in
  x86_64|amd64) ;;
  aarch64|arm64|armv*) fail "Engelbart for Linux runs on 64-bit Intel and AMD computers (x86_64); this one has an ARM processor ($machine)." ;;
  *) fail "Engelbart for Linux runs on 64-bit Intel and AMD computers (x86_64); this one is $machine." ;;
esac
command -v git >/dev/null 2>&1 || fail "Engelbart needs Git, which is not installed. Install it with $(git_hint), then run this command again."

# The query keeps a cache in front of the folder from answering with an older feed.
feed=$(curl -fsSL "${DOWNLOADS}latest-linux.yml?t=$(date +%s)") || fail "could not reach ${DOWNLOADS} (is this computer online?)."
version=$(printf '%s\n' "$feed" | awk '/^version:/ {print $2; exit}' | tr -d "'\"")
image="Engelbart-${version}-x86_64.AppImage"
sha512=$(printf '%s\n' "$feed" | awk -v f="$image" '$0 ~ "url: "f"$" {getline; sub(/.*sha512: */, ""); print; exit}' | tr -d "'\"")
[ -n "$version" ] && [ -n "$sha512" ] || fail "${DOWNLOADS}latest-linux.yml does not list $image."

# Already the newest: nothing to download (and Engelbart need not quit). ENGELBART_FORCE=1 installs again anyway.
if [ "${ENGELBART_FORCE:-}" != 1 ] && [ -x "$DEST/app/engelbart" ] && [ "$(cat "$DEST/version" 2>/dev/null)" = "$version" ]; then
  say "Engelbart $version is already installed in $DEST and up to date."
  say "Chromium's sandbox: $(sandbox_state)."
  exit 0
fi

work=$(mktemp -d)
say "Downloading Engelbart $version for Linux…"
curl -fL --progress-bar -o "$work/$image" "${DOWNLOADS}${image}" || fail "the download did not finish; run the command again."
want=$(printf '%s' "$sha512" | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
got=$(sha512sum "$work/$image" | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || fail "the download does not match its checksum; run the command again."

# Unpacked: an AppImage mounts itself with FUSE, which a stock Ubuntu 22.04 or later does not have (libfuse2).
chmod +x "$work/$image"
(cd "$work" && "./$image" --appimage-extract >/dev/null) || fail "the AppImage could not be unpacked."
[ -x "$work/squashfs-root/engelbart" ] && [ -f "$work/squashfs-root/engelbart-launch" ] || fail "the AppImage does not hold Engelbart as expected."
chmod 755 "$work/squashfs-root/engelbart-launch"

if pgrep -u "$(id -u)" -f "$DEST/app/engelbart" >/dev/null 2>&1; then
  say "Engelbart is open. Quit it and the install will go on."
  waited=0
  while pgrep -u "$(id -u)" -f "$DEST/app/engelbart" >/dev/null 2>&1; do
    [ "$waited" -ge 600 ] && fail "Engelbart was still open after 10 minutes. Quit it and run the command again."
    sleep 1; waited=$((waited + 1))
  done
fi

mkdir -p "$DEST" "$BIN_DIR" "$APPS_DIR"
rm -rf "$DEST/app.new" "$DEST/app.old"
mv "$work/squashfs-root" "$DEST/app.new"
if [ -d "$DEST/app" ]; then mv "$DEST/app" "$DEST/app.old"; fi
mv "$DEST/app.new" "$DEST/app"
rm -rf "$DEST/app.old"
printf '%s\n' "$version" > "$DEST/version"
ln -sfn "$DEST/app/engelbart-launch" "$BIN_DIR/engelbart"

# The app menu: electron-builder's entry, started through the launcher, and its icons.
for icon in "$DEST"/app/usr/share/icons/hicolor/*/apps/engelbart.png; do
  [ -f "$icon" ] || continue
  size=$(basename "$(dirname "$(dirname "$icon")")")
  mkdir -p "$ICONS_DIR/$size/apps" && cp "$icon" "$ICONS_DIR/$size/apps/engelbart.png"
done
entry=$(ls "$DEST"/app/*.desktop 2>/dev/null | head -1 || true)
{
  if [ -n "$entry" ]; then grep -vE '^(Exec|Icon|TryExec|X-AppImage-[A-Za-z]*)=' "$entry"; else printf '[Desktop Entry]\nName=Engelbart\nType=Application\nTerminal=false\nCategories=Development;\n'; fi
  printf 'Exec="%s" %%U\nIcon=engelbart\n' "$DEST/app/engelbart-launch"
} > "$APPS_DIR/engelbart.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

say "Engelbart $version is installed in $DEST: open it from the app menu, or with \`engelbart\`."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "($BIN_DIR is not on your PATH yet: it usually is after you log in again.)" ;; esac

state=$(sandbox_state)
if [ "${state%%:*}" = off ] && [ "${state#*AppArmor}" != "$state" ] && apparmor_profile; then state=$(sandbox_state); fi
say "Chromium's sandbox: $state."

if [ "${ENGELBART_NO_OPEN:-}" != 1 ]; then
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    (cd "$HOME" && setsid "$DEST/app/engelbart-launch" >/dev/null 2>&1 < /dev/null &) || true
  else
    say "No display here to open it on."
  fi
fi

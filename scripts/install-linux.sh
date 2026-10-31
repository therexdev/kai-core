#!/usr/bin/env bash
# KAI Core Beta installer for 64-bit Raspberry Pi OS and x64 Linux.
# Downloads the latest stable AppImage and verifies its GitHub SHA-256 digest.
# Run from your normal desktop account: bash Install-KAI-Core-Pi.sh
set -euo pipefail
umask 022

if [[ "${1:-}" == --help ]]; then
  printf '%s\n' 'Run: bash Install-KAI-Core-Pi.sh' \
    'Installs the latest KAI Core Beta for your user and adds desktop/menu shortcuts.' \
    'Requires 64-bit ARM or x64 Linux, curl, Python 3, and internet access.' \
    'Run without sudo. Quit any open KAI app before installing.'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  printf '%s\n' 'Unknown option. Use --help.' >&2
  exit 1
fi
if [[ "$(id -u)" == 0 ]]; then
  printf '%s\n' 'Run this installer as your normal desktop user, without sudo.' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux || ( "$(uname -m)" != aarch64 && "$(uname -m)" != x86_64 ) || "$(getconf LONG_BIT)" != 64 ]]; then
  printf '%s\n' 'This installer needs 64-bit ARM (aarch64) or x64 Linux.' \
    'It cannot run on 32-bit Raspberry Pi OS.' >&2
  exit 1
fi
for program in curl python3; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Missing %s. Install it, then run this installer again.\n' "$program" >&2
    exit 1
  fi
done

install_dir="$HOME/Applications/KAI-Core"
mkdir -p "$install_dir"
stage_dir=$(mktemp -d "$install_dir/.install-XXXXXXXX")
trap 'rm -rf -- "$stage_dir"' EXIT
printf '%s\n' 'Checking the latest KAI Core Beta release...'
curl --fail --location --show-error --retry 2 --connect-timeout 20 --max-time 60 \
  --proto '=https' --proto-redir '=https' \
  --header 'Accept: application/vnd.github+json' \
  --output "$stage_dir/release.json" \
  'https://api.github.com/repos/therexdev/kai-core/releases/latest'

python3 - "$stage_dir" "$install_dir" "$(uname -m)" <<'PY'
import hashlib
import json
import re
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

stage = Path(sys.argv[1])
install_dir = Path(sys.argv[2])
suffix = {'aarch64': 'arm64', 'x86_64': 'x86_64'}[sys.argv[3]]
release = json.loads((stage / 'release.json').read_text())
tag = release.get('tag_name', '')
if not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag) or release.get('draft') or release.get('prerelease'):
    sys.exit('The server did not return a stable KAI Core release.')
version = tag[1:]
name = f'KAI-Core-Beta-{version}-linux-{suffix}.AppImage'
assets = [a for a in release.get('assets', []) if a.get('name') == name]
url = f'https://github.com/therexdev/kai-core/releases/download/{tag}/{name}'
if (len(assets) != 1 or assets[0].get('state') != 'uploaded'
        or assets[0].get('browser_download_url') != url
        or not re.fullmatch(r'sha256:[a-f0-9]{64}', assets[0].get('digest', ''))
        or not isinstance(assets[0].get('size'), int) or not 12 <= assets[0]['size'] <= 3 * 1024**3):
    sys.exit('This release does not have a complete, checksum-verified AppImage for this computer.')
expected = assets[0]['digest'][7:]
download = stage / name
print(f'Downloading KAI Core Beta {version} ({assets[0]["size"] // 1000000} MB)...', flush=True)
subprocess.run(['curl', '--fail', '--location', '--show-error', '--retry', '2',
                '--connect-timeout', '20', '--max-time', '900', '--proto', '=https',
                '--proto-redir', '=https', '--max-filesize', str(assets[0]['size']),
                '--output', str(download), url], check=True)
if download.stat().st_size != assets[0]['size']:
    sys.exit('The download is incomplete. Existing files were not changed.')
digest = hashlib.sha256()
with download.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != expected:
    sys.exit('Download verification failed. Existing files were not changed. Run the installer again.')

home = Path.home()
data = Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share')
if not data.is_absolute():
    sys.exit('XDG_DATA_HOME must be an absolute path.')
launcher = home / '.local/bin/kai-core-beta'
icon = data / 'icons/hicolor/scalable/apps/kai-core-beta.svg'
menu = data / 'applications/kai-core-beta.desktop'
binary = install_dir / 'KAI-Core.AppImage'
for path in (home, data, launcher, icon, menu, binary):
    if any(c in str(path) for c in '\n\r\t'):
        sys.exit('Installation paths cannot contain tabs or line breaks.')

def write_atomic(path, text, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.kai-install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def desktop_string(value):
    return str(value).replace('\\', '\\\\')

def desktop_exec(value):
    value = str(value)
    for char in ('\\', '"', '`', '$'):
        value = value.replace(char, '\\' + char)
    return '"' + desktop_string(value).replace('%', '%%') + '"'

desktop_dir = home / 'Desktop'
try:
    result = subprocess.run(['xdg-user-dir', 'DESKTOP'], text=True,
                            capture_output=True, check=True, timeout=5)
    if result.stdout.strip():
        desktop_dir = Path(result.stdout.strip())
except (FileNotFoundError, subprocess.SubprocessError):
    pass
if not desktop_dir.is_absolute():
    sys.exit('The configured desktop folder must be an absolute path.')

print('Download verified. Installing application and shortcuts...')
download.chmod(0o755)
os.replace(download, binary)
write_atomic(launcher, '#!/bin/sh\n# Managed KAI Core Beta launcher\n'
             '# Run without FUSE; retain the protected GNOME Keyring backend.\n'
             'export APPIMAGE_EXTRACT_AND_RUN=1\n'
             f'export KAI_CORE_APPIMAGE_PATH={shlex.quote(str(binary))}\n'
             f'exec {shlex.quote(str(binary))}{" --password-store=gnome-libsecret" if suffix == "arm64" else ""} "$@"\n', 0o755)
write_atomic(icon, '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="shell" x2=".8" y2="1"><stop stop-color="#1bc6ff"/><stop offset=".45" stop-color="#087bff"/><stop offset="1" stop-color="#054bcd"/></linearGradient><linearGradient id="letter" x2=".7" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#b7eeff"/></linearGradient></defs>
<rect x="48" y="48" width="928" height="928" rx="235" fill="url(#shell)"/>
<rect x="65" y="65" width="894" height="894" rx="220" fill="none" stroke="#ffffff" stroke-opacity=".27" stroke-width="9"/>
<g fill="none" stroke="url(#letter)" stroke-width="117" stroke-linecap="round" stroke-linejoin="round"><path d="M324 285v97M324 746V525L718 250M559 573l187 179"/></g>
</svg>
''', 0o644)
entry = ('[Desktop Entry]\nType=Application\nVersion=1.0\nName=KAI Core Beta\n'
         'Comment=Koinos AI Core\n'
         f'Exec={desktop_exec(launcher)}\nIcon={desktop_string(icon)}\n'
         'Terminal=false\nCategories=Utility;\nStartupWMClass=kai-core\n')
write_atomic(menu, entry, 0o644)
if desktop_dir != home:
    desktop_file = desktop_dir / 'KAI Core Beta.desktop'
    write_atomic(desktop_file, entry, 0o755)
    # Some desktops need a trust marker; Raspberry Pi file managers may ask
    # "Execute"/"Trust and Launch" the first time even when this succeeds.
    try:
        subprocess.run(['gio', 'set', str(desktop_file), 'metadata::trusted', 'true'],
                       check=False, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=5)
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    print(f'Desktop icon: {desktop_file}')
else:
    print('Desktop icons are disabled in this account; the menu shortcut is ready.')
try:
    subprocess.run(['update-desktop-database', str(menu.parent)], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
except (FileNotFoundError, subprocess.SubprocessError):
    pass
print(f'Installed KAI Core Beta {version}. Open KAI Core Beta from the desktop or application menu.')
print('Future updates: Settings > Update > Restart and install (requires Core 0.7.14 or newer).')
print('If asked, choose Execute or Trust and Launch. The first launch can take a little longer.')
print('To bring over your Alpha wallet/models, use Settings > Migrate from Koinos AI Alpha.')
PY

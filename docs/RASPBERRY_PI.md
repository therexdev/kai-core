# Install and update KAI Core on Raspberry Pi

Use this guide to install KAI Core Beta, add a desktop icon, or upgrade an older Pi installation.

## What you need

- A Raspberry Pi running **64-bit Raspberry Pi OS with a desktop**.
- Internet access, `curl` and Python 3.
- Your normal desktop account. **Run the installer without sudo.**

The installer selects the ARM64 build for the Pi. It also supports x64 desktop Linux; it does not support 32-bit Raspberry Pi OS.

## Install or upgrade

**1. Fully quit KAI first.** If it is in the tray, use the tray menu's Quit option. Closing the window alone can leave it running.

**2. Open Terminal on the Pi and paste:**

```bash
mkdir -p "$HOME/Downloads" &&
curl -fL --retry 2 \
  https://github.com/therexdev/kai-core/releases/latest/download/Install-KAI-Core-Pi.sh \
  -o "$HOME/Downloads/Install-KAI-Core-Pi.sh" &&
bash "$HOME/Downloads/Install-KAI-Core-Pi.sh"
```

This downloads a fresh installer from the latest official GitHub release. It runs the installer only if the download succeeds.

You can also [download the installer](https://github.com/therexdev/kai-core/releases/latest/download/Install-KAI-Core-Pi.sh) in your Pi's browser, then run:

```bash
bash ~/Downloads/Install-KAI-Core-Pi.sh
```

**3. Wait for the installation to finish.** It downloads the app, checks its size and SHA-256 checksum, and creates desktop and application-menu shortcuts.

**4. Open KAI Core Beta from its new desktop icon or application menu.** If the desktop asks, choose **Execute** or **Trust and Launch**. The first launch can take a little longer.

**5. Open Settings and check the installed version.** It should show **0.7.14 or newer**.

## What the installer sets up

- A **KAI Core Beta** desktop icon and application-menu entry.
- A fixed app location: `~/Applications/KAI-Core/KAI-Core.AppImage`.
- A launcher that works without FUSE.
- The GNOME Keyring launch option used for protected storage on Raspberry Pi's labwc/Wayland desktop.

The installer replaces the app and its managed shortcuts. It leaves Core profiles, wallets, models and plugins in place, and does not remove Alpha installations.

To copy an Alpha wallet or models into Core, use **Settings → Migrate from Koinos AI Alpha**. Migration remains a separate, explicit action; see the [migration reference](foundation/ALPHA_MIGRATION.md).

## Future updates

After this one-time installation:

1. Open **Settings** in KAI Core.
2. When a newer version is available, choose **Download update**.
3. When the download is ready, choose **Restart and install** and approve the restart.

Automatic update checks are enabled by default and can be turned off in Settings. Downloads and restarts require your action. Finding an update or closing KAI does not install it automatically.

KAI stops its services before replacing the app, keeps the same launch path and retains the previous app file. Your desktop icon, keyring launch option, wallet, models and plugins stay in place.

**Local-Only mode pauses update checks and downloads.** Choose Local first or Network when you want to check for and download updates.

## If it still shows 0.7.12

The original Pi installer installed **0.7.12** specifically. That app's update button opens GitHub because it does not contain the Linux update installer.

Fully quit that copy, including the tray icon, and run the fresh installer command above. Then use the updated **KAI Core Beta** icon. Once Settings shows **0.7.14 or newer**, the app can install future AppImage updates.

## Common problems

| What you see | What to do |
| --- | --- |
| Updates only open GitHub | Check the installed version. Older versions need the one-time upgrade above. Copies outside a user-owned, writable AppImage location also use manual downloads. |
| The old version opens after installation | Fully quit the tray copy, then open the updated KAI Core Beta desktop/menu shortcut. |
| The desktop asks whether to run the shortcut | Choose Execute or Trust and Launch. |
| Checks are paused | Turn off Local-Only mode when you want to check for or download an update. |
| The installer reports a checksum failure | Run the fresh installer again. It does not replace the existing app when download verification fails. |
| Protected storage is locked | Unlock your desktop keyring normally, fully quit KAI, and reopen it with the managed desktop icon. The Pi launcher retains the GNOME Keyring option. |
| Your OS is 32-bit | Use a supported 64-bit Raspberry Pi OS installation. This installer cannot install the ARM64 app on a 32-bit OS. |

Linux ARM64 packaging and a native Linux x64 update/relaunch test have passed. This guide does not imply that every Raspberry Pi model or OS configuration has been hardware-tested.

[Latest downloads](https://github.com/therexdev/kai-core/releases/latest) · [KAI Core README](../README.md)

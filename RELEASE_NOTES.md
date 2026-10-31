# KAI Core Beta 0.7.14

Linux AppImages, including 64-bit Raspberry Pi OS, now support downloading updates in Settings and an explicit **Restart and install** action. Automatic checks remain optional; downloads and restarts require your action. Windows retains its existing signed installer flow, and macOS/unsupported builds keep manual downloads.

The Linux updater selects the exact architecture and stable release, verifies the official GitHub size and SHA-256 digest, stages on the same filesystem, and waits for Core to shut down before replacing the AppImage at the existing path. The previous app is retained, and immediate process-start failure restores it. Core profiles, wallets, models and plugins are outside the replacement path. Local-Only mode cancels update network activity.

The included **Install-KAI-Core-Pi.sh** installs the latest stable ARM64/x64 AppImage with desktop/menu shortcuts. On Pi it preserves the GNOME Keyring launch option and uses a fixed app path with FUSE-free extraction. Existing Pi installs need to run this installer once to reach the updater-enabled version.

Validation covers Core and service regressions, native public SDK and update UI checks, corrupted/cancelled downloads, target changes, helper failure, atomic replacement/rollback, and a disposable packaged x64 AppImage relaunch with retained test profile data. This does not claim real Pi hardware or live payment verification.

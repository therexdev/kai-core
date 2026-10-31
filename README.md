# KAI Core Beta

KAI Core Beta is the desktop foundation for independently installed plugins. Each plugin owns its interface, feature engines, dependencies, assets and saved work. Core exposes documented services that are available to every publisher; there are no private first-party feature APIs.

This is a new architecture and a new profile. It does not automatically adopt older data. Settings offers an explicit **Migrate from Koinos AI Alpha** tool for copying **Models**, **Wallet**, or both. An optional cleanup checkbox removes verified Alpha model originals after transfer. Documents, plugin data, connected accounts and settings are excluded. Existing Koinos AI/Core 0.6 data is left untouched. On Windows the new profile is `%APPDATA%\KAI Core\foundation-v1`. The Koinos Node plugin owns a **separate Node wallet**, clearly labelled in its interface.

The Beta name is display branding. Core keeps the `io.koinosai.core` application ID, the internal `KAI Core` OS identity and the existing `KAI Core/foundation-v1` data location. Windows keeps its `KAI Core.exe` executable and Linux keeps `kai-core`; installer and portable download filenames include `KAI-Core-Beta`.

## Application updates

Settings shows the installed version, checks for new Core releases, and offers an optional automatic-check setting (on by default). Local-Only privacy pauses checks and downloads. An update badge appears on Settings when a newer release is available.

The installed Windows Setup version and user-owned Linux AppImages can download a verified update inside Core. **Restart and install** is an explicit action that stops Core's services before launching the installer. Closing to the tray, exiting normally, or finding an update never installs or restarts automatically. Portable Windows, macOS and non-AppImage Linux builds check for new releases and open the official downloads page for manual installation. Plugin updates remain separate in Plugins.

Version 0.7.7 and earlier need one manual installation of the updater-enabled version. Application updates preserve the Core profile, wallet, models, installed plugins and plugin data. See [Windows signing and release setup](docs/foundation/WINDOWS_UPDATES.md) for the required Azure signing configuration and release verification.

### Raspberry Pi and Linux installation

Download **Install-KAI-Core-Pi.sh** from the [latest release](https://github.com/therexdev/kai-core/releases/latest), quit Core, then run `bash ~/Downloads/Install-KAI-Core-Pi.sh` from your normal desktop account, without sudo. It selects ARM64 for 64-bit Raspberry Pi OS or x64 for desktop Linux, verifies the release's size and SHA-256 checksum, and creates desktop/menu icons. The launcher uses a fixed `~/Applications/KAI-Core/KAI-Core.AppImage` path and FUSE-free extraction. On Pi it retains `--password-store=gnome-libsecret` for protected keyring storage on labwc/Wayland. Existing profiles and Alpha installations are untouched; migration remains an explicit Settings action.

Linux versions before 0.7.14 need this one manual installation. From 0.7.14, Settings checks automatically by default; choose **Download update**, then **Restart and install**. Updates stop in Local-Only mode. They never run `sudo`, install system packages or disable Electron's sandbox. An installation in a system-owned/unwritable folder keeps the manual-download option. On Linux the download is authenticated through the official GitHub release/API over HTTPS and its exact size/SHA-256 digest; it does not carry an independent publisher code signature. Windows retains its timestamped Authenticode policy.

A detached helper verifies the staged AppImage again and waits for Core's process to exit before an atomic replacement at the existing path. It retains `<AppImage>.previous`; an immediate process-start error restores that previous file. A later crash inside the new app is not automatically rolled back. A failed post-quit installation writes `<AppImage>.update-error.txt` and attempts to reopen the retained app. Wallets, models, plugins and profiles are never part of replacement. Native Linux verification uses a disposable packaged x64 Electron AppImage; real ARM64/Pi hardware still requires a device check.

## Ownership

| Core foundation | Installed plugins |
|---|---|
| Desktop shell, tray, Apps navigation and ordering | Each feature's complete interface and controllers |
| Signed package installation, lifecycle and service routing | Background work, schedules and feature-specific processes |
| Shared local model runtime and inference | Assistant conversation logic, providers, voice and desktop companion |
| Identity, shared wallet, credits and reviewed spending | Brain, connected services, workflows and agent services |
| Network policy, protected account requests and secure-storage primitives | Documents, coding, comparisons, developer tools and MCP |
| Common service-management screens and simple model chat | Koinos Node's node/wallet/funding and Remote Access's keys/gateway/relay |

Core does not include these optional feature engines. The build generates an explicit production file list and fails if an optional engine re-enters that dependency graph. Installing a plugin supplies its engine; removing it stops the feature and removes it from Apps. Versioned package files and saved data remain in the profile. Plugin data is separate from versioned code.

## Runtime and trust

A **sandboxed** plugin has an isolated browser interface, no Node integration and a small capability API for local inference and its own settings.

A **native** plugin runs trusted JavaScript in Electron's main process and may include prebuilt native dependencies. This is **full computer and application access**, not an adversarial sandbox. Native code can access files, credentials, programs and the app itself; it can also crash the app. The install dialog explains this before approval. All eleven full-feature KAI plugins use this runtime. Signatures identify the publisher's key; they do not certify that code is safe.

Native plugins use the same versioned SDK regardless of publisher. Core does not normally return wallet keys or account tokens through that SDK, but this is not a promise that malicious native code is confined. Remote Agent Network job payloads use a separate bounded runner without access to native plugin APIs, accounts or Brain data.

Enabled services remain alive while navigating between Apps and while Core is in the tray. Disable, removal and update revoke SDK access and invoke cleanup. Quit drains plugin services. An external service such as Docker has its own lifecycle as described by its plugin.

## Build a plugin

- [Plugin author guide](docs/foundation/PLUGIN_AUTHOR_GUIDE.md)
- [Public API types](docs/foundation/api-v1.d.ts)
- [Architecture](docs/foundation/ARCHITECTURE.md)
- [Sandboxed notes example](examples/sandboxed-notes)
- [Native counter and service example](examples/native-counter)

A Foundation package uses manifest schema 2 and plugin API 3; its native SDK version is 1. UI and service entries, permissions, provided services and consumed services are declared in the signed manifest. Dependencies are resolved and bundled by the author before publication. Core never runs npm or package install scripts on the user's computer.

Plugin-to-plugin calls require declared service contracts. Providers retain responsibility for their own approvals and validate requests. The broker preserves the actual initiating interface for attended cross-plugin approvals and credit budgets. Hosted remote jobs cannot acquire that interface's authority.

## Development

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test
npm run test:services
npm run test:foundation-native
npm run test:alpha-migration
npm run test:credit-reconnect
npm run test:apps
npm run dist -- --win --x64
```

The all-app smoke requires sibling plugin checkouts and Assistant's prepared payload. It uses a disposable profile and test signing key, not live wallet/account credentials. Live Docker, OAuth, microphone hardware and blockchain transactions require separate explicit testing. Main releases publish the Windows update feed only after signature, publisher, timestamp and exact-artifact verification. Preview branch builds do not publish releases.

The original application lives in `therexdev/kaiapp` and is not modified by this project. Foundation is a clean plugin platform, not a compatibility layer for its old internal objects.

Imported-wallet purchased credits and recent remote activity are restored from **Credits and Usage → Restore wallet credits**, after unlocking and approving the same-wallet connection. The installation keeps its own protected session; old credentials are not imported.

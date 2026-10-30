# KAI Core

KAI Core is the plugin-based successor to Koinos AI. The **Core 0.6.1 / first-party plugins 0.2.x** source restores the original feature workspaces and engines as separately installed apps inside Core. It replaces the reduced 0.1.1 plugin interfaces.

The reference is `therexdev/kaiapp` Test commit [`34d17faa0526213b8fc0ac7a65aa7f2c186c6547`](https://github.com/therexdev/kaiapp/commit/34d17faa0526213b8fc0ac7a65aa7f2c186c6547). This repository starts from that source snapshot; earlier Git history remains in `kaiapp`. Source version numbers and passing development tests do not establish that a corresponding installer has been published or verified on every platform.

## The desktop

Core keeps the familiar pearl/cobalt shell, simple local/network text chat, model installation and runtime management, Wallet, Credits and Usage, Earn KOIN, Plugins, and the original bottom-left Network and Settings navigation. The wallet retains balances, history, sends and native password-protected backup. As in the original app, explicit wallet actions and the opted-in Koinos Node use the blockchain independently of AI Local-Only; they never change AI privacy to enable online AI. Earn retains Wallet KAI and estimated KOIN Drop amounts separately from paid KOIN rewards and chat credits. Settings includes the original website-account linking controls; website and AI-credit identities remain separate.

The full Assistant, Brain, Connections, Workflows, Agent Network, Documents, Model Compare, Code, Tools, Koinos Node and Remote Access experiences live in plugins. Their original screens call reviewed native adapters to the original engines. This includes advanced Assistant modes and desktop companion, scheduled workflows, connected actions, coding commands, tool servers, the full Node wallet/funding/producer controls and the original authenticated remote API. Remote Access 0.2.1 contains only its API/relay workspace; Node, Developer tools and Code are opened through Apps instead of Optional sections inside Remote Access. See the [parity matrix and retained limitations](docs/core/PLUGIN_PARITY.md).

Installed plugins appear under **Apps** in the sidebar. Use the hamburger handle to drag them into your preferred order; focused handles also support Arrow Up/Down and Home/End. The order is saved across restarts, and Apps is hidden when nothing is installed. Disabled plugins remain listed with a management shortcut. Opening an app loads its isolated page inside Core. Switching pages preserves its state and running work.

Closing the main window hides Core in the tray when a tray is available. **Quit KAI Core** drains native work and releases the shared profile. Opened app pages and configured background services remain alive while Core is open or in the tray; disable/remove stops the feature. App pages load on demand, while enabled background services resume their previously configured behavior at startup. Node deliberately preserves the original Docker behavior on Core quit: use **Stop node** to stop containers, or disable/remove the plugin. If a tray cannot be created, closing Core quits normally.

Network model choices use current provider readiness with the local wallet and verified account ownership excluded. A model served only by your computer/account is available through **Local model**, not offered as a prepaid network choice. A linked wallet/account can still use the same model from another provider. Independent free access must connect the wallet before using a network model that this computer is also serving. Provider availability is checked again before submission.

## Existing data

Core preserves the `Koinos AI` Electron profile/credential identity, wallet/address, model locations and original feature stores. It makes verified configuration backups before opening an existing profile. It does not replace an existing wallet, move model files or automatically restore payment journals. Alpha, Test and Core exclude one another through the shared singleton: fully quit the other application, including its tray process, before starting Core.

An installed, enabled, verified 0.2.0-or-later feature can resume its original saved intent at Core startup: for example configured workflow schedules, Brain awareness, approved MCP auto-connect, enabled remote access or existing Node supervision. Installing a feature does not authorize new automation or new spending. Original passwords, grants, step approvals, privacy rules and financial reviews remain applicable. Corrupt, unavailable or externally changed protected data fails closed instead of being silently reset. See [profile compatibility](docs/core/PROFILE_COMPATIBILITY.md).

## Install and update plugins

Use **Plugins** for the signed catalog. Listings have icons, readable names and descriptions. Core refreshes catalog metadata at startup, every 15 minutes, and on app/Plugins returns with a one-minute throttle; failed checks retry after five minutes. A numbered badge shows installed plugins with newer versions, including disabled plugins. Updates requiring a newer Core remain visible with that requirement.

Catalog refresh does **not** install packages. Every installation/update requires native permission review and verifies its signature, publisher, exact catalog digest and Core compatibility. One previous package is retained for rollback. Removal retains private plugin data and publisher ownership for reinstall. Local-Only pauses catalog checks and downloads; a previously downloaded package can still be selected locally.

**Install 3rd Party Plugins** is the expandable form at the bottom of the marketplace. Developers can host signed packages in their own GitHub repositories or other public HTTPS locations and submit entries to the separate [registry](https://github.com/therexdev/kai-plugin-registry). Community plugins use the public API; an unrelated signature cannot claim an official ID or its private feature permissions.

**Core updates remain manual.** Settings starts an update check, asks before downloading, and asks again before restarting to install. Core does not automatically download or install updates. Its installer identity and release feed are separate from Alpha/Test. Availability depends on an actually published compatible release.

## Development and verification

Requires Node 24 and npm:

```sh
npm ci
npm start
npm test
npm run test:compat
```

The desktop intentionally uses the existing KAI profile. Use the supplied temporary-profile fixtures for unattended testing; do not start a headless server against a real profile. Core's direct server entry is disabled in this build.

`npm run test:plugins` exercises the eleven original plugin workspaces in the actual Electron host with synthetic services. `npm run test:apps` covers persistent embedded navigation, drag order, tray continuation and teardown; `npm run test:desktop` covers the Core shell, and `npm run test:plugin-sandbox` covers the renderer boundary. Feature-specific tests cover saved-data preservation, approvals, streaming, cancellation, background lifetimes and Node signing/broadcast guards. Native fixtures use generated profiles and controlled transports; they do not spend real funds or publish user services. See [verification scope](docs/core/PLUGIN_PARITY.md#verification-scope).

`npm run test:native-profile` is the separate executable/profile-continuity check. Windows/macOS/Linux packaging, real OS keychains, microphone/camera/voice devices, live relays and real provider integrations need their own native verification. A Linux headless synthetic smoke is not evidence that those work on a user's machine.

`npm run dist -- --linux --x64` builds locally with publication disabled. The **Core preview installers** workflow builds platform artifacts. Source publication, package signing and installer publication are distinct steps; follow the [release gates](docs/core/ARCHITECTURE.md#release-gates) before recommending replacement of an earlier app.

- [Feature parity and original limitations](docs/core/PLUGIN_PARITY.md)
- [Plugin API and packaging](docs/core/PLUGIN_API.md)
- [Plugin repositories](docs/core/PLUGIN_REPOSITORIES.md)
- [Architecture and release gates](docs/core/ARCHITECTURE.md)

# KAI Foundation

KAI Core 0.7 is the desktop foundation for independently installed plugins. Each plugin owns its interface, feature engines, dependencies, assets and saved work. Core exposes documented services that are available to every publisher; there are no private first-party feature APIs.

This is a new architecture and a new profile. It does not automatically adopt older data. Settings offers an explicit **Migrate from Koinos AI Alpha** tool for copying **Models**, **Wallet**, or both. An optional cleanup checkbox removes verified Alpha model originals after transfer. Documents, plugin data, connected accounts and settings are excluded. Existing Koinos AI/Core 0.6 data is left untouched. On Windows the new profile is `%APPDATA%\KAI Core\foundation-v1`. The Koinos Node plugin owns a **separate Node wallet**, clearly labelled in its interface.

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

The all-app smoke requires sibling plugin checkouts and Assistant's prepared payload. It uses a disposable profile and test signing key, not live wallet/account credentials. Live Docker, OAuth, microphone hardware and blockchain transactions require separate explicit testing. Preview builds do not publish an automatic update feed; Core updates remain manual.

The original application lives in `therexdev/kaiapp` and is not modified by this project. Foundation is a clean plugin platform, not a compatibility layer for its old internal objects.

Imported-wallet purchased credits and recent remote activity are restored from **Credits and Usage → Restore wallet credits**, after unlocking and approving the same-wallet connection. The installation keeps its own protected session; old credentials are not imported.

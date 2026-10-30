# KAI Core

Plugin-based successor to Koinos AI. This repository is independent of the old
Alpha/Test release pipelines, starting from `kaiapp` Test commit
`34d17faa0526213b8fc0ac7a65aa7f2c186c6547` with the original history retained in the source repository.

## What runs now

- Electron desktop with Overview, Models, Plugins, Wallet & credits, Earn KOIN and Settings.
- Existing local models/runtime manager and OpenAI-compatible local API.
- Existing wallet/address, encrypted credential identity, credits and provider services.
- The same user profile and model paths. Alpha, Test and Core use one Electron lock:
  fully quit the other app (including its tray process) before starting Core.
- Verified configuration backup before the new runtime opens an existing profile.
- Signed plugin packages installed from a file or public HTTPS URL, with native
  permission review, enable/disable, removal, one-version rollback and isolated storage.
- Sandboxed plugin windows with an explicit capability broker. V1 capabilities:
  installed-model metadata, bounded local inference, and the plugin's own JSON data.
- A separate Core installer ID and updater feed. Preview builds do not publish to
  either the old app's feed or the Core updater automatically.

## Development

Requires Node 24 and npm. Run `npm ci`, then `npm start`.
The desktop uses your existing KAI profile by design. Core must not be launched
headlessly against that profile; the direct server entry is disabled for this build.

`npm test` runs the Core suite; `npm run test:compat` runs the retained wallet,
model, credit and gateway checks. Some backend integration tests require a separate
backend checkout and report skips when it is absent.

`npm run test:desktop` exercises a temporary synthetic profile through the real
Electron app. `npm run test:plugin-sandbox` tests the real plugin renderer/broker.
On Windows, `npm run test:native-profile` checks all Alpha/Test/Core lock combinations
and reuses a synthetic OS-encrypted credential between separate executables.

`npm run dist -- --linux --x64` builds a local AppImage. The **Core preview
installers** GitHub workflow builds Windows, Linux x64/arm64 and macOS artifacts.
These are preview artifacts, not signed public releases. Platform signing and
native upgrade verification are required before replacing the old app publicly.

## What is deliberately not claimed complete

Core is a working development preview, not yet full replacement parity. Workflows,
Agent Network, Brain, Connections, Documents, Assistant, Code, model comparison,
node management and remote access are retained as legacy source pending extraction.
Their data stays in place; Core does not run their saved schedules or automation.
The catalog is not yet hosted. Install signed packages directly in the meantime.
Third-party Node/native plugins, public-web plugin tools, paid agent rentals and
workflow plugins are not implemented by this foundation.

Legacy sources, docs and tests are kept to make extraction traceable. Optional
speech/mail/workflow dependencies are development-only; they do not ship in Core.
The small Local Chat SDK example demonstrates the plugin API, not the complete
legacy Assistant or a migration of its chat history.

- [Profile compatibility](docs/core/PROFILE_COMPATIBILITY.md)
- [Plugin API and packaging](docs/core/PLUGIN_API.md)
- [Plugin repositories and extraction order](docs/core/PLUGIN_REPOSITORIES.md)
- [Architecture and release gates](docs/core/ARCHITECTURE.md)

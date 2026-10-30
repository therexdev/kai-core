# KAI Core

Plugin-based successor to Koinos AI. This repository is independent of the old
Alpha/Test release pipelines, starting from `kaiapp` Test commit
`34d17faa0526213b8fc0ac7a65aa7f2c186c6547` with the original history retained in the source repository.

## What runs now

- Familiar pearl/cobalt desktop with Chat, Models, Plugins, Wallet, Credits and Usage,
  Earn KOIN, and the original bottom-left Settings and Network navigation.
- Simple built-in text chat with separate local/network conversations. Local chat
  cannot fall back to the network; network chat uses the existing verified credit
  service and delivery recovery. Advanced tools remain optional plugins.
- Your Credits shows available balance, purchases and usage; Buy credits opens a
  separate purchase screen with the existing native quote approval.
- Wallet warnings and other action messages have a dismiss button. Dismissed
  messages stay hidden during background refresh; an explicit retry can show a new result.
- Closing the window keeps Core and active earning in the system tray. Use the
  tray icon to reopen it, or **Quit KAI Core** to stop services and release the shared
  profile. If a tray icon cannot be created, closing the window quits normally.
- Existing local models/runtime manager and OpenAI-compatible local API.
- Existing wallet/address, encrypted credential identity, credits and provider services.
- The same user profile and model paths. Alpha, Test and Core use one Electron lock:
  fully quit the other app (including its tray process) before starting Core.
- Verified configuration backup before the new runtime opens an existing profile.
- Signed plugin packages installed from a file or public HTTPS URL, with native
  permission review, enable/disable, removal, one-version rollback and isolated storage.
- Sandboxed plugin windows with an explicit capability broker. Public capabilities:
  installed-model metadata, bounded local inference, and private plugin JSON data;
  API 2 adds publisher-bound feature adapters.
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

## Install the feature plugins

Core 0.4.2 includes direct install cards for eleven signed first-party plugins in
**Plugins**. Choose **Refresh catalog** to fetch the signed public
[plugin registry](https://github.com/therexdev/kai-plugin-registry). Catalog installs
verify the exact package digest, publisher, permissions and Core compatibility.
Bundled official releases are available before the first registry refresh. After
loading a catalog, an expired or invalid catalog must be refreshed before choosing
a catalog release; installed plugins and direct package installation still work.
Every installation asks you to review permissions; nothing installs automatically.
Local-Only privacy blocks downloads; a downloaded `.kaiplugin` file can be installed
under **Install 3rd Party Plugins** at the bottom of the marketplace. Third-party signed packages still use the public API.

Available repositories: [Assistant](https://github.com/therexdev/kai-plugin-assistant),
[Brain](https://github.com/therexdev/kai-plugin-brain),
[Connections](https://github.com/therexdev/kai-plugin-connections),
[Workflows](https://github.com/therexdev/kai-plugin-workflows),
[Agent Network](https://github.com/therexdev/kai-plugin-agent-network),
[Documents](https://github.com/therexdev/kai-plugin-documents),
[Model Compare](https://github.com/therexdev/kai-plugin-model-compare),
[Code](https://github.com/therexdev/kai-plugin-code),
[Tools](https://github.com/therexdev/kai-plugin-tools),
[Koinos Node](https://github.com/therexdev/kai-plugin-koinos-node), and
[Remote Access](https://github.com/therexdev/kai-plugin-remote-access).

Their renderers are independently versioned packages. Reviewed native adapters and
the shared workflow runtime stay in Core. Each private API is bound to its matching
plugin ID, publisher key and explicit grant. Account tokens and wallet keys remain
in the native process. Processes/files/account actions receive additional review.

## Preview scope

These are preview feature releases, not full legacy feature parity. Built-in simple
chat keeps conversations in memory for the current app session; the Assistant plugin
provides saved conversations. The original data remains in the shared profile.
Assistant supports saved text conversations; legacy desktop mascot/live microphone
features are not extracted. Workflows runs the supported local/manual graph subset;
unsafe legacy flows and saved schedules remain preserved and inactive. Agent Network
supports private free services; external discovery needs a configured compatible
relay. Paid rental contracts are not deployed or enabled by these plugins. Code edits
selected project files with native approval and does not run arbitrary shell commands.
Each repository documents its implemented operations and limits.

Koinos Node reuses saved node settings and paths, with reviewed Docker inspection,
configuration and explicit start/stop controls. Opening it never resumes production,
reward automation or wallet operations. Remote Access is opt-in, uses scoped API
keys and only exposes installed-model listing and bounded local inference through
the configured relay. It never forwards the private Core API. Both services stop
when their plugin closes or Local-Only is selected.

Platform signing,
real-install upgrade checks, macOS Keychain and Linux Secret Service continuity still
need verification before recommending replacement of the old app. Existing profile
backup and mutual exclusion remain mandatory. No plugin auto-imports wallet funds,
launches saved MCP servers, resumes legacy schedules or publishes agent services.

Legacy source is retained for continued extraction. Speech/mail dependencies remain
development-only. The shared workflow engine's QuickJS and cron dependencies ship
with Core, but the workflow broker does not expose native or unrestricted code nodes.

- [Profile compatibility](docs/core/PROFILE_COMPATIBILITY.md)
- [Plugin API and packaging](docs/core/PLUGIN_API.md)
- [Plugin repositories and extraction order](docs/core/PLUGIN_REPOSITORIES.md)
- [Architecture and release gates](docs/core/ARCHITECTURE.md)

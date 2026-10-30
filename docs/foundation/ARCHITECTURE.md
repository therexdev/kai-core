# Foundation architecture

## Boundary

Core is the application host and shared service provider. Its native entry is `electron/core-main.js`; its local model/identity/network service entry is `core/server.js`. Neither constructs optional feature engines. `scripts/foundation/source-closure.js` enumerates the production dependencies and `build-manifest.js` creates the exact installer file list.

The plugin host presents persistent sandboxed `WebContentsView` instances in the Apps section. A separate generic lifecycle manager verifies and materializes each signed package, loads its declared native service and revokes its SDK when disabled, updated or removed. Native modules and dependencies resolve within the installed package, apart from Node/Electron built-ins. This avoids accidental Core dependency coupling; it is not an OS sandbox.

## Package and storage

Package schema 2 declares API 3, runtime, HTML entry, optional native service entry, capabilities and consumed/provided service names. The publisher signature authenticates the manifest and every packaged file. The installed approval binds its exact signed content and publisher. Dependencies and platform assets are built by the publisher; installation executes no dependency installation scripts.

`plugins-v3` contains installation metadata, immutable verified code versions and separate per-plugin writable data. New packages cannot silently substitute another publisher, even after a plugin is removed and its data retained. Updates stop/revoke the previous instance before activating the next. A failed cleanup blocks a new instance until cleanup can be retried.

The Foundation profile is independent of old releases. There is no shared mutable legacy feature store. The optional Settings migration copies only user-selected Alpha model files and/or its encrypted wallet into Core-owned storage. It never imports plugin data or adopts the old profile. See [Alpha migration](ALPHA_MIGRATION.md). Plugin data ownership is Brain → memories/sources/awareness; Connections → providers/accounts; Workflows → definitions/runs/schedules; Assistant → conversations/providers/voice/desktop; Code → projects/sessions; Tools → tool servers and developer engines; Documents → documents; Compare → comparisons; Node → node and independent wallet; Agent Network → service/job state; Remote → keys/usage/relay.

## Public APIs and approvals

`electron/foundation-api.js` implements SDK version 1. Model execution, network policy, plugin settings, credential encryption, account requests, wallet summaries, reviewed credit operations and desktop navigation are explicit services. SDK calls validate declared permissions and lifetime. Financial calls use Core's existing authorization and ledger logic; feature execution stays in the plugin.

Plugin service calls require a declared consumer and provider, a registered method and bounded serializable input/output. Core stamps the exact initiating renderer and propagates it across local RPC. Providers can request a Core-owned approval naming both applications. Background calls cannot invent a visible initiating interface. Remote contexts are rejected by this local service bus.

CreditService instances have separate journal/recovery directories derived from the initiating plugin ID and publisher fingerprint. A delegated Tools execution retains the original approved budget scope. One plugin cannot recover another's saved responses through the SDK. Native extensions remain fully trusted OS code and can bypass SDK conventions; this is disclosed at installation.

## Native trust and remote jobs

Native services run in Electron's main process. Process isolation and OS sandboxing are not claimed. Native extensions can affect Core availability and private files; publisher trust is required. Sandboxed UI has no Node integration, direct network access or arbitrary filesystem access.

Agent Network job graphs run in the plugin's isolated, resource-bounded job engine. They are data, not native extensions: no filesystem, connected accounts, Brain access, native API object or service bus is provided to remote jobs. Installing a native hosting plugin does not elevate a rented job's payload.

## Verification

Unit tests cover signatures, extraction, dependency ownership, lifetimes, generic capabilities, network policy, invocation provenance, credit scopes and source boundaries. Native smoke launches an unrelated publisher's package. All-app smoke launches the real Core with each installed feature, checks actual interfaces/services and the Assistant companion, and exercises navigation/tray/shutdown in a disposable profile. Platform CI is required before delivering an installer.

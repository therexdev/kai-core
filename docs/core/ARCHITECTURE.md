# Core architecture and release gates

This describes Core 0.5.0 and the restored 0.2.0 first-party plugin source. The reference application is `therexdev/kaiapp` Test commit `34d17faa0526213b8fc0ac7a65aa7f2c186c6547`.

## Runtime ownership

`electron/core-main.js` owns the native desktop, shared-profile lock, migration preflight, plugin installation, payment review and shutdown. `ui-core` supplies the familiar shell, simple chat, models, wallet, credits, earning, network and settings. The tray hides the main window on Close when available; explicit Quit drains native work before releasing the profile lock. The installer ID and Core release feed are separate from Alpha/Test, while the runtime name, userData, sessionData and credential identity remain compatible.

`core/server.js` starts with `extensions:false`. This avoids eagerly starting every optional legacy feature. Installed and enabled official plugins instead acquire the original services through reviewed adapters and `legacy-runtime.js` / `legacy-core-services.js`. Shared CompanionHub services are acquired by feature, so Brain, Connections and Workflows share the original data and execution semantics. Agent Network retains its separate service store and isolated execution validator.

First-party renderers package their original UI modules, markup, styles, localization and required media. Bridges adapt their transport and application navigation to separate windows. Native engines remain in Core: plugins cannot package a replacement privileged engine or obtain an unrestricted gateway/IPC proxy. Core imports only fixed non-secret desktop preferences from the preserved origin; feature data continues to use its original stores.

The plugin host checks signatures, publisher ownership, exact sender/main frame and entry URL, declared permissions and method allowlists. Sandboxed renderers have separate ephemeral sessions and no direct network/filesystem access. Official inline styles and the Assistant's specifically reviewed media/native companion capabilities are bounded exceptions for original behavior. See [PLUGIN_API.md](PLUGIN_API.md) for package and renderer details.

## Background services and shutdown

At startup, `FeatureServices.startInstalledBackground` verifies each enabled package, official publisher, restored version and complete required permissions before acquiring its background service. It does not activate missing/disabled plugins or grant new permissions. Original saved flags decide what runs: workflow schedules/events, Brain awareness/source sync, MCP auto-connect, Agent Network acceptance, Remote Access and Node intent retain their original meaning.

Closing a feature window aborts that window's pending requests. Background-capable services retain their own lifetime. The original Code, Documents and Model Compare request lifetimes still cancel active foreground work when their windows close. Disable/remove revokes a feature, cancels or drains pending work, and releases its native resources. Local-Only applies original privacy policy and stops prohibited external services; it does not silently redirect a local request to a paid model.

Node is a deliberate distinction. Closing its window keeps supervision and configured reward/funding work alive. Core quit drains operations, closes supervision and releases ownership while preserving the original running Docker containers. Explicit plugin disable/remove stops the managed node and awaits Docker shutdown. AI Local-Only is independent of Node networking, configured mining/funding and explicit wallet actions, matching the original gateway and Local API screen; changing AI privacy neither stops those services nor changes their blockchain authorization. Setup downloads/watchers cannot launch a delayed installer after cancellation. Original funding journals remain available for recovery; shutdown does not roll back or recreate a submitted transaction.

Sensitive Node operations share the Core wallet spend gate with credit purchases and wallet transfers. Captured operation guards bind identity, network and lifetime across asynchronous preparation, signing, external-wallet requests, sponsor submissions, Ethereum batching/retries and Koinos failover. Background operations acquire fresh service leases instead of inheriting the window that originally configured them. Native review uses stored human-readable draft summaries and fingerprints for external producer operations. Wallet keys stay native.

## Profile and data continuity

The preflight creates and verifies private configuration/credential backups before runtime initialization. Wallets, installed models, node databases and original feature files remain in place. Guarded adapters retain unknown fields, protect concurrent changes and reject unreadable/corrupt data instead of manufacturing a replacement. Keychain failure is a locked/unavailable state, never a reason to downgrade to plaintext.

Original memory/task migration uses the original migration path through guarded stores. It preserves source records, paused/enabled intent, identity and history; it must not run a duplicate legacy task scheduler alongside Workflows. Profile mutual exclusion prevents concurrent Alpha/Test/Core access, but does not prove backward compatibility with every historical schema. Any future incompatible schema change needs a separate compatibility decision.

Settings restores original website-account device-code linking, wallet linking, sign-out and scoped web grants. The website account used by Connections and the AI-credit account are distinct routes. The local wallet/address and payment journals stay owned by Core. Core wallet balance/history reads and explicit password/native-reviewed transfers remain available with AI Local-Only unchanged; wallet lock, selected blockchain network, identity and window lifetime still guard financial operations. Simple built-in chat uses session-memory transcripts; Assistant supplies original saved conversations and advanced modes.

## Registry and updates

Catalog metadata is separately signed and pins package digests, publishers, permissions, minimum Core versions, validity and monotonic release sequence. The monitor checks startup/every 15 minutes and app returns with a one-minute throttle; failures retry after five minutes. Manual refresh joins the current check. Local-Only and shutdown abort downloads. Package installation pins the reviewed catalog entry while metadata checks are paused.

The Plugins badge counts strictly newer releases for installed IDs from the same publisher, including disabled plugins. Incompatible updates are shown with their Core requirement. Valid cached entries survive a failed refresh; an invalid/expired catalog does not fall back to withdrawn bundled entries. Catalog refresh never installs software.

Core updates are manual: check, approve download, then approve restart. Auto-download and install-on-quit are disabled. Plugin installation also requires native permission review. Source publication, immutable plugin artifacts, registry publication and platform installer releases are separate operations.

## Release gates

1. Run Core and relevant plugin tests, retained compatibility tests and focused original-engine regressions. Record failures and backend-dependent skips; a test name is not evidence of execution.
2. Run the integrated eleven-plugin Electron fixture against the final source/packages, including startup/background behavior, saved-task migration, Developer tools, app integrations and media permission paths after their final changes. A smoke from an earlier intermediate revision does not validate later edits.
3. Verify package signatures, source correspondence, binary assets, contract permissions and catalog digests/minimum versions. Run the real plugin sandbox probe with the Chromium OS sandbox enabled under a normal supported user.
4. Build and launch packaged installers with their production dependencies and voice/media assets. Verify shared-profile exclusion and encrypted credential continuity across separate Alpha/Test/Core executables on each supported platform.
5. Verify real Windows/macOS/Linux keychains, signing/notarization, upgrade/uninstall behavior and relevant native device/runtime paths. Live models, OAuth/providers, relays and funding services require separate controlled integration checks where applicable.
6. Publish only through the manual release process. A passing synthetic fixture does not authorize or perform a real payment, wallet migration, chain action, service publication or backend deployment.

The Linux test environment may require a headless renderer, a test-only `--no-sandbox` switch or a fixture singleton substitute when normal OS facilities are unavailable. These are limitations to record, never production settings. Synthetic tests create temporary profiles and controlled transports; they do not establish real OS keychain migration or user-machine device behavior. Current staged verification scope is documented in [PLUGIN_PARITY.md](PLUGIN_PARITY.md#verification-scope).

# Original feature parity: Core 0.5.1 / plugins 0.2.x

The reference is `therexdev/kaiapp` Test commit [`34d17faa0526213b8fc0ac7a65aa7f2c186c6547`](https://github.com/therexdev/kaiapp/commit/34d17faa0526213b8fc0ac7a65aa7f2c186c6547). The restoration uses its original feature engines and UI modules instead of the reduced 0.1.1 plugin substitutes. Original limits, approvals and deployment dependencies are part of parity. This document describes source behavior and release gates; it is not a declaration that an installer or every external integration has been verified.

## Feature matrix

| Feature | Original experience restored | Native engine and saved data | Boundary adaptations |
| --- | --- | --- | --- |
| Assistant | Conversation rail/search/favorites, streaming, regenerate, citations, text/images, personas, advanced research/agent/team modes, providers, voice and desktop companion | Original chat/Companion routing, payment services, speech/mascot services and saved chats/preferences | Feature-scoped requests; original native approvals; explicit microphone/camera access; selected provider credentials remain native |
| Brain | Overview, memory graph, memories, goals/tasks, sources, sync/changes, awareness and orchestration | Original CompanionBrain, sources, awareness and shared encrypted CompanionHub store | Original actions through an allowlist; selected filesystem imports/native exports; workflows use the shared original engine |
| Connections | Full original app catalog/categories, profiles, OAuth, connected tools/permissions, custom APIs, action receipts and grants | Original Connections/Composio/source services and encrypted credentials | Native reviewed actions and scoped status; website-account linking opens Core Settings; AI-provider settings open Assistant |
| Workflows | My workflows, run history, templates, discovery, graph editor/Copilot, validation, previews, undo/redo, import/export | Original workflow engine, node library, schedules/events, run snapshots and guarded legacy-task migration | Personal workflows retain selected Brain/app context and step approvals; no reduced local/manual-only subset |
| Agent Network | Discover, My agents, Jobs, Earnings, Activity, Network settings, service editor, invitations and delivery review | Original signed service/job protocol and separate encrypted `agent-network.json` | Only compatible isolated service graphs can be hosted; no caller access to private Brain, connected accounts, desktop or wallet keys |
| Documents | Original rail/writing canvas, autosave, word count, model picker, selected-text AI editing and streamed Apply/Discard/Stop | Original document/streaming routes and existing document files/IDs | Revision/lifetime guards prevent delayed generation or autosave overwrites; native text/Markdown import/export |
| Model Compare | Blind model pairs, presets, sequential streaming, Stop, reveal, voting and local scoreboard | Original comparison/model-streaming route and retained scoreboard preference | Scoped Compare API and fixed preference migration; no reduced generic prompt form |
| Code | Original projects/sessions, plans, diffs, approvals, slash commands, models/tools and GitHub screens | Original CodeAgent, CodeProjects, GitHub client and project/session data | Actual edits, commands and Git actions receive native review; protected Core/profile paths cannot be projects; project inference stays local |
| Tools | Tools & accounts, MCP catalog/custom servers, trust/auto-connect/local-safe flags, Node runtime, email/calendar and Developer tools | Original MCP, runtime, email/calendar, developer controls and saved settings/credentials | Server/process and external-account actions remain reviewed; developer requests use dedicated scoped adapters |
| Koinos Node | Dashboard, Wallet, Fund node, Burn KOIN → VHP, Node, Reward returns and Settings; full setup, logs, history, quick sync, backups, data moves and external producer modes | Original KoinosNode, chain, funding/reward engines, shared wallet, custody/Vault, journals and selected database path | Exact native financial review, shared wallet gate, lifecycle checks through submission; key backup stays in native UI; unsigned draft export uses native picker |
| Remote Access | Original Local API/Remote Access page, key creation/revocation, examples, budgets, usage, privacy and remote connection controls | Original gateway API-key manager and RemoteAccess relay/identity | Authenticated `/v1/` routing/streaming preserved; no `/core/`, desktop broker or wallet exposure; one-time new key display retained |

The original full workflow node library includes agents and selected read tools, connected actions, public HTTP, bounded JavaScript, Brain operations, branches/switches/merges, parsing/deduplication, loops/sub-workflows, approvals and saved chat output. Graph validation, execution limits, privacy checks and uncertain-action recovery remain in the original engine.

Core itself retains simple chat, model/runtime management, the original wallet presentation, credits/purchases/usage, Earn KAI/KOIN Drop information, network/privacy controls and account linking. Installing a feature does not duplicate the wallet, model files or encrypted account identity. Other feature screens open their separately installed app pages under **Apps**; an absent plugin must be installed before that editor can open.

Remote Access 0.2.1 deliberately removes the original Optional sections panel and its Node, Developer tools and Code controls. Those capabilities remain in their own apps, accessible through Core’s Apps sidebar and Plugins manager. This requested change supersedes that part of the original-screen parity baseline.

## Background and privacy

| Feature/lifetime | Switch page / close Core to tray | Core startup with verified enabled package | Disable/remove or Core quit |
| --- | --- | --- | --- |
| Assistant | Keeps the app renderer, active requests and its native service | Initializes original preferences/services/assets; no invented saved mascot autolaunch or unsolicited media request | Stops native companion/service work and drains pending requests |
| Brain / Connections | Keeps original feature service | Resumes original configured awareness, source/sync and connection behavior | Releases feature timers/requests; original encrypted data remains |
| Workflows | Schedules and running automation belong to the feature | Starts original enabled schedules/events and migrates legacy task intent through guarded stores | Stops feature execution/scheduling; retains workflows and receipts |
| Agent Network | Configured acceptance/service stays active | Resumes prior enabled service settings | Stops hosting/polling; preserves services/jobs |
| Tools | Configured tool services stay active | Original approved auto-connect flags may start configured servers | Disconnects/stops feature services; preserves configuration |
| Node | Supervisor, configured rewards and approved funding flows stay active | Reads original saved supervisor/return/funding intent with full Node permissions | Disable/remove stops managed containers and drains work; Core quit drains work and preserves original Docker continuity |
| Remote Access | Enabled relay remains active | Resumes only saved enabled access with original API keys and permitted privacy | Stops relay and active sessions; preserves key records/identity |
| Code / Documents / Compare | Retains the renderer, foreground work and pending approvals | No automatic foreground edit, document generation or comparison | Cancels/releases requests and preserves saved work |

Local-Only governs AI privacy and blocks prohibited AI/tool traffic and remote activation. Koinos Node networking, configured mining/funding and explicit blockchain wallet actions are independent, exactly as described by the original Local API screen and gateway. They remain available without changing AI privacy; switching AI mode does not stop an opted-in Node or erase wallet balances/history. Original explicitly reviewed local-safe tool behavior remains subject to the tool policy. Returning online resumes only behavior authorized by existing feature settings; no plugin creates new grants or paid work simply because its window opens.

## Deliberate transport changes

Original layout and controls do not imply original renderer privileges. Plugin JavaScript uses `window.kai.call` and explicit native capabilities; it cannot import Node, fetch arbitrary Core routes, read files or obtain account tokens. Native adapters preserve the original operations behind that boundary.

- Navigation opens Core or another installed plugin through fixed view/section names.
- Clipboard, file pickers, external links and sensitive filesystem/process actions use native reviewed paths.
- Wallet private-key backup is displayed/copied natively; keys are never returned to plugin JavaScript.
- Original password, transaction, connected-action and agent step approvals remain. Native review binds financial actions to the actual identity/network/payload or stored draft summary.
- Hiding an app is distinct from destroying it. App requests continue across sidebar navigation and tray use. Actual teardown revokes its renderer lifetime; configured background services obtain their own service lifetimes. Native approval still binds each sensitive operation to its identity and arguments.
- Dismissible notices and saved-data/concurrency guards prevent stuck messages and silent overwrites without removing original features.

## Retained original limitations

**Agent rentals:** the reference deployment did not enable paid service contracts. The original free service protocol, discovery/hosting, signed quotes/results, jobs and acceptance remain available with compatible relays/hosts. Paid rental settlement and paid-service reputation are not newly implemented. The Earnings screen retains that limitation. No public directory or relay is silently selected.

**External dependencies:** OAuth/Composio, email/calendar, GitHub, network models, funding/onramp/bridge services and Remote Access need their original accounts, configuration and reachable services. Local models and voice runtimes must exist or be installed through their original flows. The plugin extraction does not substitute fake responses for unavailable services.

**Native platform behavior:** camera/microphone, OS speech, desktop controls, Docker/WSL, keychains and code-signing behavior vary by supported platform. Original explicit permissions still apply. A synthetic profile can test decisions and transport without proving that a user's real keychain, microphone or Docker installation works.

**Data and recovery:** locked credentials and corrupt/changed stores remain unavailable until deliberately recovered. No wallet is regenerated over an existing wallet; financial journals are never automatically rolled back. Feature data stays in the shared profile, and Alpha/Test/Core must not run simultaneously against it. Package rollback does not undo external actions or imply that all future storage schema changes are backward compatible.

**Core chat:** simple built-in chat retains session-memory conversations by design. The Assistant plugin supplies the original persistent conversation workspace and advanced features.

## Verification scope

Development verification has exercised the original renderers inside the real Electron plugin host using generated signed fixture packages and temporary profiles. Source-stage native runs have covered all eleven workspaces; feature runs also cover Brain/Connections, account linking, Code/Documents, Node navigation/background startup and reviewed cancellation. Focused tests cover original engines, store preservation, exact approval binding, streams, provider/relay isolation and Node signing/submission lifetimes. No real user wallets, payments, production relays or user files are required by those fixtures.

The 0.5.1 source and Linux `app.asar` runs passed all eleven actual publisher-signed packages: Workflows and Agent Network 0.2.1; the other plugins 0.2.0. Each run made 23 synthetic model calls with zero renderer errors, external-service calls or process attempts. Coverage includes visible original rails/panes, preserved paused legacy tasks/history, background startup/window-close behavior, Developer Tools teams/pipelines/benchmark, Remote localization and feature switches, Node under unchanged AI Local-Only, and native media consent. The packaged run also served all six original VAD/ORT browser assets from the built archive/extraResources. Core passed 476 tests and 47 compatibility tests, with 10 existing integration skips. The complete desktop fixture passed with a synthetic monitor, tray and profile; its container-only singleton stub does not prove OS locking. The signed catalog and all eleven published assets passed online digest verification. Native installer/platform CI and real external-service/keychain checks remain distinct from these synthetic results.

Useful entry points:

```sh
npm test
npm run test:compat
npm run test:plugins
npm run test:desktop
npm run test:plugin-sandbox
npm run test:native-profile
node --test core/test-core/plugin-node-lifetime-audit.test.js
```

Run each plugin repository's `npm test` and package verifier too. Source hash/provenance manifests identify copied original assets; package signature/source checks verify the distributable matches reviewed files.

Real packaged Windows/macOS/Linux launch, OS keychain continuity, application exclusion, sandbox behavior, platform signing/notarization, microphone/camera/voice and live external-service integrations remain separate release gates. Headless Linux tests may use fixture-only sandbox/singleton workarounds, which must never be presented as native platform verification. See [ARCHITECTURE.md](ARCHITECTURE.md#release-gates).

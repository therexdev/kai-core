# KAI Core 0.5.0

Restores the original feature interfaces and engines in separately installed plugins, using the Koinos AI baseline `34d17faa0526213b8fc0ac7a65aa7f2c186c6547`.

- Full Node sidebar, wallet/history, funding, external producer signing, mining, recovery and reward returns.
- Original Assistant chat/providers/voice/companion; Brain and Connections; full workflow builder, schedules and task migration; isolated Agent Network; Documents, Code, Compare; Tools/Developer Tools; Local API/Remote Access with original feature switches and localization.
- Original saved data, model paths and account/wallet identity remain in the shared profile. Optional services resume saved intent when their verified plugin is enabled. Core updates remain manual.
- AI Local-Only retains the original separation from explicit blockchain wallets and the opted-in Node; financial approvals and identity/lifecycle checks remain enforced.

Install Core 0.5.0 manually, then update the installed feature plugins in Plugins. Workflows and Agent Network are 0.2.1; the other plugins are 0.2.0. Each update requires its permission review. Fully quit the other KAI app, including its tray process, before opening Core.

See [the parity matrix](PLUGIN_PARITY.md) for the native boundary adaptations, original limitations and actual verification scope. Synthetic tests do not submit transactions or prove real keychain migration and external-service availability. Platform installers are built by the Core preview installers workflow; no automatic updater release is published.

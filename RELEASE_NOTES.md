# KAI Foundation 0.7.0

KAI Core is now the shared foundation for independently installed feature plugins. The Assistant, Brain, Connections, Workflows, Agent Network, Documents, Model Compare, Code, Tools, Koinos Node and Remote Access own their engines, interfaces, dependencies and saved data.

This release starts a fresh profile. It does not migrate earlier documents, accounts, wallets, settings or model files. Existing installations and their data are left untouched. Foundation plugins require Core 0.7 and use the separate Foundation catalog.

Core provides a documented public SDK, plugin lifecycle and service routing, shared model/runtime services, network controls, identity, wallet/credit approvals and desktop navigation. The same APIs are available to third-party publishers. Enabled plugins remain active while navigating and while Core is in the tray. Apps can be reordered from the sidebar.

All full-feature KAI plugins are native extensions with full computer and application access. The install review explains that trust level. Remote Agent Network job graphs use a separate restricted runner and do not receive the native SDK, connected accounts or Brain access.

Install the Windows Setup build for a normal installation or Portable to launch without installing. Core updates remain manual. These installers are not published to the automatic update feed.

Validation includes platform CI, signed package verification, shared-service tests and real Electron lifecycle/SDK checks. Linux integration also launched all eleven plugin interfaces and the Assistant desktop companion. Live Docker, microphone hardware, OAuth sign-in and blockchain transactions are not exercised by these automated checks.

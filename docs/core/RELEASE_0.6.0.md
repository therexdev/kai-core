# KAI Core 0.6.0

Installed plugins now appear in an **Apps** sidebar section and open inside Core. Drag the hamburger handles to reorder them, or focus a handle and use Arrow Up/Down, Home or End. The order persists across restarts; removing the last plugin hides the section. Disabled apps remain visible and lead to plugin management without enabling themselves.

Opened app pages retain their drafts, renderers and ongoing work when switching sections or closing Core to the tray. Previously configured native background services resume at startup. Disabling, removing or updating an app revokes its renderer and drains its services; quitting Core performs the existing shutdown. Node retains its original Docker continuity on quit, and its Stop control or plugin disable stops the managed node. The sidebar, Settings and Network remain accessible when the installed app list scrolls.

Prepaid network choices exclude providers owned by the local wallet or verified linked account. Self-only models are removed from the picker; linked buyers can use the same model through another provider. Independent free access cannot request a model currently also shared by the unlinked local earning wallet, and explains how to connect the wallet or use Local instead. Availability is rechecked before submission, and previously completed requests remain recoverable. Refresh never silently switches an invalid selection to a different paid model. See the [protocol scope](ARCHITECTURE.md#prepaid-model-availability).

The original signed plugin packages are unchanged: Workflows and Agent Network 0.2.1, the other nine 0.2.0. Users still on 0.1.x should open **Plugins → Refresh catalog** and review each update to obtain the complete original interfaces.

Core updates remain manual. Existing wallet/profile/model paths and the mutual-exclusion lock with Alpha/Test are unchanged. No backend deployment, live transaction or real-account migration is part of these changes.

Validation includes the Core and compatibility suites, focused payment/admission and app lifecycle regressions, all eleven actual signed plugins in the Electron source host, and a native Apps fixture covering drag/keyboard order, restart persistence, isolated embedded rendering, tray completion, disable cancellation and quit teardown. Native fixtures use temporary profiles and synthetic services. Platform checks and preview installers are published separately; the Linux container fixture does not establish real Windows/macOS keychain or device behavior.

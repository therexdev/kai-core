# KAI Core 0.7.3

Core and plugin approvals, warnings and alerts now use the same font, colors, spacing and buttons as the plugin installation popup. This includes token-send reviews, wallet-credit connections, model and network approvals, media access and native plugin messages. Every message dialog has a close X and safe Escape handling; long details remain readable and scroll within the window.

Closing a review, leaving its originating app, hiding Core in the tray or stopping the operation cancels the review. Approval still requires an explicit user decision and the original operation checks. Hidden plugins cannot request media permission. Dialog content is rendered as text in an isolated Core-owned window.

Install Core 0.7.3 first, then update the plugins offered in Plugins. Assistant, Brain, Connections, Workflows, Tools and Code 0.3.1 and Koinos Node 0.3.5 replace their remaining browser dialogs and align their active custom popups with the app. Reusable budget dialogs clear prior results before reopening. Node includes the read-only configuration startup repair from 0.3.4.

Profile, model, wallet and per-plugin data locations stay unchanged. `foundation-v1` and `plugins-v3` describe storage formats, not release numbers. The hash-named code subfolders remain immutable verified package snapshots; saved plugin data stays in the same separate `data` folder through updates and rollback.

System file pickers and operating-system permission prompts continue to use their native interfaces. Core updates remain manual; no automatic updater feed is enabled.

Validation includes approval/cancellation and stale-context regression tests, rendered desktop dialog checks, native SDK and installed-app checks in disposable profiles, and platform CI. No live funds, user wallet or node operations are used for these checks.

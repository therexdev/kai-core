# KAI Core 0.5.1

Includes the complete original-feature restoration from [0.5.0](RELEASE_0.5.0.md), plus the macOS profile-path correction found by platform CI. Node and Remote Access normalize the approved profile path before opening original services; system aliases such as `/var` and `/private/var` address the same files. Unsafe links inside the profile, changed settings and profile replacement remain blocked.

The plugin releases are unchanged: Workflows and Agent Network 0.2.1, other plugins 0.2.0. Core updates remain manual. This patch uses a new installer version to distinguish it from the earlier 0.5.0 preview artifacts.

Validation includes 476 Core tests, 47 compatibility tests (10 existing integration skips), and all eleven actual signed plugins in the native source fixture. Platform CI reruns the native and published-plugin checks for each installer target.

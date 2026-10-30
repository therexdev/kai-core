# KAI Core 0.6.1 and Remote Access 0.2.1

Removes Remote Access’s Optional sections panel and the Koinos Node, Developer tools and Koinos Code controls, links and cross-feature broker. Those apps remain available through the Apps sidebar and Plugins manager.

Remote Access retains its local API example, API keys, budgets, usage, privacy selector, localization, remote relay and configured background startup. The new plugin no longer requests permission to manage other features. Core still verifies older signed Remote packages and cached catalog entries for update/rollback continuity, but the retired feature-control method is denied.

Install Core 0.6.1, then update Remote Access to 0.2.1 through Plugins. The signed catalog marks the Core requirement. Other plugin packages, saved settings, wallet data and model paths are unchanged. Core updates remain manual.

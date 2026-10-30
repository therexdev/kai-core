# KAI Foundation 0.7.2

**Restore purchased credits and activity.** Your Credits now offers **Restore wallet credits** for an imported wallet. Unlock it if needed, then approve connecting this installation. Core proves ownership of the same wallet and reloads its existing purchased balance and recent server-side purchase/usage history. No new purchase or old credential-file migration is needed. Records that existed only in the old application's local recovery journal are not reconstructed from the wallet.

**Testnet KAI and expected KOIN drop.** Fixed the broken Earn balance endpoint left after Node functionality moved into its plugin. The public wallet balance now loads independently of AI privacy and wallet unlock, with bounded, validated reads. The estimate remains 1 KOIN per 5 Testnet KAI and excludes pending rewards. Service failures remain explicit rather than displaying a made-up zero.

**Optional model cleanup.** The Alpha migration popup now includes **Delete old models after migration**, off by default. Same-drive transfers avoid a second full model copy. Across drives, Core verifies and flushes each copied file before deleting its Alpha original, freeing source space as it proceeds. Interrupted transfers can be retried. Cleanup is limited to Alpha's models folder; external imported files and generated runtime caches are retained and identified in the result. Alpha's wallet is never deleted.

The Koinos Node plugin has a separate update for reviewing and migrating a stopped legacy node's chain data. Update that plugin through Plugins when its catalog update appears. Wallets, production keys, KOIN and VHP are not migrated with the chain.

Core updates remain manual. Validation includes model transfer and cancellation tests, actual desktop migration and credit reconnection checks, and same-wallet restoration against a local backend with synthetic balances and transactions. Live user funds and a live Docker blockchain were not moved during testing.

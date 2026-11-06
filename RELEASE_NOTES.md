# KAI Core Beta 0.7.21

Fixes empty Wallet history and missing KAI airdrop payment receipts when the first RPC node has an empty account-history index.

- Wallet and Earn now check the remaining configured history services before accepting an empty result.
- The drop monitor allows more time for fallback and canonical receipt verification. The exact amount, sender, recipient, KOIN contract and irreversible mainnet block must still match before **PAID** and **TX** appear.
- Existing payments are detected automatically when Wallet or Earn refreshes. Do not resend a completed drop.

Update through **Settings → Check for updates → Download update → Restart and install**, then open **Wallet** and **Earn**. Portable Windows and macOS users can download the new build from this release.

## Previous release: 0.7.20

Earn now shows the exact final KAI-to-KOIN airdrop allocation for each eligible wallet:

- Amounts match the final 32-wallet drop record, using 5 KAI per KOIN and rounding to eight decimal places per wallet.
- A green **PAID** badge and **TX** link appear after a finalized mainnet KOIN transfer matches the exact amount, recipient and designated Master Node sending wallet.
- Payments received while Core was closed are found when Earn checks history again. Checking works with the wallet locked and earning disabled.
- Network outages retain the fixed allocation and retry. Unrelated transfers, VHP and failed transactions do not count as this KOIN drop.

This temporary display will be removed when the legacy drop is retired. It does not send funds or start earning.

Update through **Settings → Check for updates → Download update → Restart and install**, or download the appropriate installer below. Update **Master KAI Koinos Node** separately in Plugins to version **0.1.7** for the new Airdrops tab.

## Previous release: 0.7.19

Choose where Core stores your models in **Settings → Model storage**:

- Select separate folders for downloaded models and custom GGUF imports, including another drive.
- Existing files are copied and verified before Core saves their new locations. **Remove original files after verification** is optional and off by default.
- Future downloads and imports use the selected folders immediately, and the choices survive restart. New GGUF imports keep their original source files.
- Transfers preserve model names, vision projectors and partial downloads, and never overwrite a different file at the destination. Progress and cancellation are available in Settings.
- Wallets, plugin data, node data, runtime files and Ollama caches keep their current locations. Node storage remains controlled by its plugin.

On installed Windows and supported Linux AppImages, open **Settings**, check for the update, choose **Download update**, then **Restart and install**. Portable Windows and macOS users can download the new build from this release.

Keep your selected model drive connected when using Core. Finish or cancel local model work before transferring folders; existing network work is allowed to finish first.

## Previous release: 0.7.18

Improves Earn KOIN connection stability and recovery:

- Network confirmations refresh independently of slower setup and model-catalog checks, reducing unnecessary ONLINE / CONNECTION UNCONFIRMED switching.
- Temporary catalog timeouts, rate limits and server errors keep an already authorized worker running with its approved models while Core retries.
- Waking the computer reconnects the earning worker and refreshes its signed model presence without unlocking the reward wallet or enabling earning again.
- Expired confirmations, revoked authorizations and privacy changes still remove online eligibility. Choosing Stop prevents delayed requests or wake events from restarting earning.

On installed Windows and supported Linux AppImages, open **Settings**, check for the update, choose **Download update**, then **Restart and install**. Portable Windows and macOS users can download the new build from this release. Wallets, models, installed plugins and saved data remain in place.

## Previous release: 0.7.17

Adds a language picker on first launch and a saved Language setting for Core and plugins. English, Spanish, Brazilian Portuguese, French and German use bundled offline catalogs. Open plugin views receive language changes through the public read-only locale API; drafts and user content remain intact. The plugin author guide includes the API contract and a complete localized example.

The coordinated plugin source updates require Core 0.7.17. Release Core first, then newly signed plugin versions and a signed catalog with the matching minimum Core version.

## Previous release: 0.7.16

Fixes the misleading “Core desktop access denied” error that could appear after choosing **Restart and install**. Core now stops refreshing its status before services shut down and shows a normal restart message while the update is prepared.

Canceling a restart keeps the app available, and update verification failures remain visible. Desktop access checks, installer signature verification, and service cleanup still run normally. Your wallet, models, plugins, and saved data stay in place.

The fix takes effect once 0.7.16 is installed. When updating from an older version, the old app may still show the message once as it closes.

# KAI Core Beta 0.7.18

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

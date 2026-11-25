# KAI Core Beta 0.7.41

Recover KOIN credit purchases when the wallet is still connected to an older Koinos AI Alpha installation on the same computer. In **Buy credits → Recover Alpha purchase connection**, select the original Alpha profile folder and review the connection. On Windows, the usual folder is `%APPDATA%\Koinos AI\core`.

Windows recovery opens the selected Alpha profile’s original protected connection without changing Core’s credential store. Core verifies the saved signing identity with the server and continues using the original payment journal in its original folder. Completed purchases and pending-payment recovery stay together. Keep that folder available; moving or deleting it blocks further purchases until its records are recovered.

The recovery action does not sign a payment or reset the server's wallet binding. Selecting a folder and confirming the connection are required; Core never automatically imports an Alpha profile. Each new purchase still requires its own approval. Unresolved transactions in other payment journals, damaged records, mismatched configurations, and another computer's recovery anchor remain blocked.

Update through **Settings → Application updates → Download update → Restart and install**. No additional server or plugin update is required.

## Previous release: KAI Core Beta 0.7.40

Fixes credit purchases blocked by a signing-lease error after an account or credit configuration change on the same Core profile. Core can reuse the original encrypted signing identity already saved for that wallet, service and chain, and remembers it independently of the selected account. A replacement identity from an unsuccessful attempt no longer hides the original record.

The server must confirm the existing identity before payment review. This does not reset its wallet binding, transfer signing to another computer, overwrite payment journals or clear pending transactions. Wallet approval is still required for every purchase.

Update through **Settings → Application updates → Download update → Restart and install**, then retry the purchase. The previously deployed $1,000 credits-server update remains required; this release needs no additional server update.

## Previous release: KAI Core Beta 0.7.39

Buy up to **$1,000 in credits per transaction** using KOIN. Core now checks the purchase against its USD value at the verified exchange rate, fixing the older 100-KOIN deposit cap that blocked larger purchases. The amount field displays the $1,000 maximum, and requests above it are rejected before wallet signing.

This requires the matching [credits-server update](https://github.com/therexdev/kai/blob/fix/credit-purchase-limit-1000/deploy/koin-mainnet/PURCHASE_LIMIT.md). That update separates the merchant's $1,000 credit-sales limit from the small exchange-price validation probe that previously capped purchases just below $10. Fresh pricing, signed quotes, exact payment review, and wallet approval still apply.

Update through **Settings → Application updates → Download update → Restart and install**. No plugin update is required. Existing credit balances, wallets, and pending payment recovery records are preserved.

## Previous release: KAI Core Beta 0.7.38

Connect Core to the same login used by website Chat, Build and Credits/API. **Settings → KAI account & credits → Connect to my KAI account** now opens your browser with the approval code filled in, matching the Android flow. Approve there and return to Core. A backup code and Retry connection remain available if the browser or connection fails.

For an existing wallet-only connection, choose **Link to my website account**, approve the website login, then **Link this Core wallet**. The review names the receiving account and wallet before granting access to its existing credits. Purchased balances, the original daily allowance and financial recovery records are preserved. Shared credit access can be removed from Core or the website; KOIN purchases still require wallet approval.

Website Chat stays at [koinosai.com/chat](https://koinosai.com/chat), Build at [koinosai.com/build](https://koinosai.com/build), and Credits/API at [credits.koinosai.com/account](https://credits.koinosai.com/account). Chat uses an optional primary credit account, then other linked accounts in the order added. The companion [server rollout](https://github.com/therexdev/kai/blob/fix/rpc-adaptive-recovery/docs/ACCOUNT_WORKSPACE.md) must be activated for shared website credit access.

Update through **Settings → Application updates → Download update → Restart and install**. No plugin update is required. Existing wallets, balances, chats, plugins, models and files are retained. Interrupted approvals can recover the same session, and cancelled or older approvals cannot replace a newer connection.

## Previous release: KAI Core Beta 0.7.37

Fixes short Assistant messages being rejected by the saved per-request credit limit when using Kimi K3.1 Pro or GLM 5.3. When no reply length is specified, Core now fits the reply allowance to the selected model's approved price and the existing credit limit. It includes the full conversation's input reservation and never raises the spending cap or removes messages. Higher-priced models may provide shorter replies under the same limit.

All six hosted models are covered by default-request, price-boundary, signed-reply and recovery checks. Requests with an explicit reply length keep that limit; if their reservation is too high, the error now shows the required credits and saved cap.

Update through **Settings → Application updates → Download update → Restart and install**, then resend the message. No separate Assistant plugin update is required. Existing chats, credit records, wallets and model files are retained.

## Previous release: KAI Core Beta 0.7.36

Fixes "Choose the approved network model" when selecting GPT OSS 120B or another newly added network model after an earlier chat. Core now checks new requests against the current approved model list while preserving the original prices and request identity when recovering a saved reply.

Update through **Settings → Application updates → Download update → Restart and install**, then resend your message with the desired network model selected. The fix applies to Assistant and other plugins using Core's network chat service. No separate plugin update is required. Existing chats, credit records, wallets and model files are retained.

## Previous release: KAI Core Beta 0.7.35

Removes Dev Tiny, the pipeline testing model labeled "not a launch model", from the local Model library and the model choices exposed to plugins and local API clients. The production catalog no longer offers its testing weights for download.

Update through **Settings → Application updates → Download update → Restart and install**. No server or plugin update is required for this removal. The six Akash network models remain available through the Network model source. Existing model files, wallets, plugins and saved data are retained.

## Previous release: KAI Core Beta 0.7.34

Adds GPT OSS 120B, Llama 3.3 70B, Qwen 3.8 27B, GLM 5.3, Qwen 3.6 35B A3B and Kimi K3.1 Pro to normal network model selection when the credit server enables them. These hosted models use the same daily-free and purchased KAI credits as other network models. The backend applies a 25% supplier-cost markup, except Qwen 3.6 and Kimi K3.1 Pro at 15%.

The six models share one additional available network provider. They do not earn KOIN usage or availability rewards and cannot be shared through desktop Earn. The API key stays on the server. Text replies arrive after their complete usage and signed billing receipt are verified.

Update through **Settings → Application updates → Download update → Restart and install**. The operator must also complete the [AkashML server activation](https://github.com/therexdev/kai/blob/fix/rpc-adaptive-recovery/deploy/koin-mainnet/AKASHML.md). Models appear as available only after the server validates the supplier catalog and pricing. No plugin update or model download is required for hosted inference. Existing wallets, models, plugins and saved data are retained.

## Previous release: KAI Core Beta 0.7.33

Fixes Raspberry Pi/Linux plugin installation failing with `ENOENT`, `lstat` or a missing `/tmp/appimage_extracted_...` directory after opening Core again while it was already running. Managed launches and update restarts retain the shared extracted application files so a second instance cannot remove code still needed by the running app. Existing managed Pi launchers are repaired when the updated Core starts.

Update through **Settings → Application updates → Download update → Restart and install**. If the current app already shows this error, fully quit Core including its tray instance, then reopen it once before updating or retrying installation. Your wallets, models, plugins and saved data are retained. Teleno 1.2.0 itself does not need another plugin update.

Native release checks exercise repeated launches and plugin verification/installation using the packaged x64 and ARM64 AppImages. These are runner checks, not a claim of testing on every physical Pi.

## Previous release: KAI Core Beta 0.7.32

Local model context now grows automatically for each task, within the model's supported limit and your optional per-model cap. Short requests start with a small allocation. Longer requests can request more room; Core verifies the running engine's allocation before inference and queues resizing behind active replies.

Leave **Models → Automatic context** on Auto for normal use. Set an optional cap there to limit memory use. Larger windows need enough available RAM/VRAM; a configured limit is not proof that the engine can allocate it.

Update through **Settings → Application updates → Download update → Restart and install**. For the Android app's Koinos API connection, also update **Remote Access to 0.3.4** and install **kai Android 0.4.16**. The app discovers the context limit automatically, including after restart and for saved tasks. Existing model files, API keys and saved data are retained.

This update applies to local inference through Core and its public plugin API. Prepaid-network context limits and credit approvals are unchanged.

## Previous release: KAI Core Beta 0.7.31

**Remove** now warns before permanently deleting a plugin's installation folder, all installed versions, saved files, settings and local credit history. The warning includes plugin-specific wallets, keys and backups stored in that folder. Back up anything you need before confirming removal.

Choose **Disable instead** to keep the plugin's files and settings while stopping it and hiding it from the Apps menu. You can enable it again on the Plugins page. Failed or interrupted removal stays disabled with **Retry removal**, including after restarting Core.

Shared Core wallets and models are kept. Custom folders outside Core, such as a separate node-data drive, still require plugin-specific cleanup and are not deleted by this update. Installing the update itself does not remove any plugins or saved data.

Update through **Settings → Application updates**, then choose **Download update** and **Restart and install**. This is a Core update; plugin updates are not required for cleanup of Core-managed files.

## Previous release: KAI Core Beta 0.7.30

Fixes Network overview showing **0 models available** when other providers still have models ready. The model and provider counts now both describe the whole network. Account restrictions appear separately, including guidance to connect your wallet under **Credits and Usage** when sharing models through an unlinked free-access account.

The overview still reports genuine changes in provider readiness. Interrupted status checks show **Last known network status**, and model-use buttons continue to enforce account eligibility.

Update through **Settings → Application updates**, then choose **Download update** and **Restart and install**. This is a Core update; no plugin update is needed for the overview correction.

## Previous release: KAI Core Beta 0.7.29

Adds **Model library → Unsupported Earn Models** for downloading and testing Gemma 4 12B, Muse-Glimmer 30B, Qwen 3.8 27B, and Gemma 4 31B locally. Cards show file sizes, suggested memory, and an optional GitHub feedback report. Downloads reuse the existing queue, cancellation, and SHA-256 verification.

These experimental models cannot be offered or used for Earn, including when sharing all compatible installed models. Approval requires a later reviewed Core catalog change and the matching network tariff/pins. Local testing does not qualify a model for rewards.

Update through **Settings → Application updates**, then choose **Download update** and **Restart and install**. Open **Model library → Unsupported Earn Models** to try the new choices. These are experimental local models; loading speed and writing quality still need community testing.

## Previous release: KAI Core Beta 0.7.28

Native plugin model requests now have a bounded 15-minute Core ceiling, replacing the shared 180-second deadline that could terminate a network reply while its provider was loading a model, processing the prompt or generating. A plugin can still set a shorter timeout. This applies equally to local inference, network completions and explicit saved-response recovery; ordinary credit reads retain their existing limit.

Stop, plugin shutdown, revoked credit access and privacy changes retain their existing cancellation behavior. No generation or payment is automatically resent by this change. Credit approvals, token budgets and verified recovery records are preserved.

Update through **Settings → Application updates** and restart Core. Update **Workflows to 0.3.14** in the plugin catalog for its matching 10-minute per-reply setting and research corrections. Updating only one layer does not remove both old three-minute limits.

## Previous release: 0.7.27

Temporary network failures during model availability, price, balance and saved-reply checks now get up to two retries within the request deadline. This lets a workflow continue when a brief gateway failure clears. Persistent failures identify which check failed.

Retries keep the same request inputs and respect cancellation and revoked access. Generation and payment requests are never automatically resent. Saved replies still require their original request ID and verified provider signature.

Update through **Settings → Application updates**, then restart Core. Keep **Workflows 0.3.11** from the in-app catalog; existing article imports need no changes. Finish or cancel active work before restarting.

## Previous release: 0.7.26

Keeps network replies connected while a model loads or processes a prompt. Core opts in to server keep-alive messages and treats them only as connection activity, never generated text or billable usage. This requires the matching [credit-server update](https://github.com/therexdev/kai/blob/fix/credit-stream-keepalive/deploy/koin-mainnet/CREDIT_STREAM.md).

If a reply connection breaks, Core checks the same request for an already completed, signed answer without submitting another generation. Verified partial replies and request records remain saved. Unrecoverable disconnects show a clear network error instead of `terminated`. Cancellation, output limits and credit approvals still apply.

Update through **Settings → Application updates**, then restart Core. Keep **Workflows 0.3.11** from the in-app catalog; existing article imports need no changes. Finish or cancel active work before restarting.

## Previous release: 0.7.25

Fixes the network transport used by Workflows and other plugins requesting a complete model response. Core now receives signed replies incrementally instead of leaving long requests silent behind a gateway. Plugins still receive one completed answer, with the same credit approval and token limits.

HTML gateway responses now report a clear network error and HTTP status instead of “Unexpected token '<'”. Request records and verified partial replies remain available for recovery. Buffered callers require the provider's final signature, and recovery reads the saved job without starting another generation.

Update through **Settings → Application updates**, then restart Core. Keep **Workflows 0.3.9** from the in-app catalog; existing article imports need no changes. Finish or cancel active work before restarting.

## Previous release: 0.7.24

Fixes model availability expiring while Core checks network eligibility. Pricing and provider observations are fetched together, validated when both arrive, and refreshed up to twice if they expire in transit. Provider identity, signed prices and freshness checks remain enforced.

Adds a public native SDK signal for availability failures confirmed to occur before generation starts. Automatic-model plugins can refresh and select another eligible model while preserving normal credit approval. Interrupted requests and saved answers retain their recovery records; uncertain outcomes are never marked safe to retry.

Replies that exhaust their verified output token budget now report the length limit, allowing existing workflow continuations to finish long outlines and sections instead of treating a clipped answer as complete.

Install Workflows 0.3.8 from the in-app catalog for automatic research, outline and writing fallback. Existing imported article workflows continue to work without reimporting.

Update through **Settings → Application updates**, then restart Core before updating Workflows.

## Previous release: 0.7.23

Adds reusable credit permissions for plugins. Network approval can now offer **Allow once**, **Allow for Workflow**, and **Allow Always**.

- **Allow for Workflow** covers the current run, including later steps and continuations. It ends when the run finishes, fails, is cancelled, or Core exits.
- **Allow Always** lets the same plugin publisher use the approved credit account across future runs and restarts, including background runs. Core still verifies each request and available credits.
- **Settings → Access** lists ongoing credit access and lets you revoke it. Revocation blocks queued uses and cancels active requests where possible. Already consumed credits cannot be undone.
- Credit purchases and KOIN transfers retain their separate approvals. Local-Only continues to block network work.

Install Workflows 0.3.7 from the in-app catalog to use these controls with workflow runs.

Update through **Settings → Application updates**, or download the appropriate installer below.

## Previous release: 0.7.22

Moves the compact KOIN/USD balance box to the top of the sidebar, directly above **Chat with KAI**. Click the box to open Wallet; it replaces the separate Wallet menu item and highlights when Wallet is open.

Update through **Settings → Application updates**, or download the appropriate installer below.

## Previous release: 0.7.21

Adds a compact KOIN wallet summary beneath the upper sidebar menu and fixes missing wallet history and KAI airdrop receipts.

- The sidebar shows your liquid KOIN balance with its estimated USD value underneath. Click it to open Wallet; hover to see all eight decimals. Missing or stale price data shows a dash, and USD price requests pause in Local-Only mode.
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

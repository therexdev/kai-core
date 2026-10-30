# Profile compatibility

Core preserves Electron's runtime name `Koinos AI` and explicitly points both
`userData` and `sessionData` at `<appData>/Koinos AI`. Its installer is `KAI Core`,
app ID `io.koinosai.core`, with updates from `therexdev/kai-core` only.

The default data directory remains `<userData>/core`. `KAI_CORE_DATA` retains the
existing override convention. Core acquires the shared Electron singleton before
reading or backing up that directory. A blocked launch shows an instruction to
fully quit the running Alpha/Test/Core application. Closing Core's main window
hides it in the tray when a tray is available; use **Quit KAI Core** to release
the profile. Without a tray, Close quits normally. AI privacy remains independent
of opted-in Node networking and explicit blockchain wallet actions. Native disposal settles
in-flight handlers and stops feature services before the lock is released.

## Preserved storage

| Data | Handling |
| --- | --- |
| Wallet/address and encrypted session | Existing files and OS credential identity reused; no new wallet generated over an existing one |
| Purchased credits/payment journals | Existing account capability and journals reused; no replay or automatic rollback |
| Model catalog/imported model paths | Existing state and files reused in place |
| Model/runtime/voice downloads | No bulk copy or redownload during adoption |
| Chats/documents | Retained in place for their plugins |
| Brain/workflow/connection data | `companion-hub.json` stays in place; enabled official feature adapters use the original services through guarded storage and OS credential access |
| Original scheduled tasks | Workflows uses the original migration path through guarded storage, preserving paused/enabled intent, source records and history without running a duplicate legacy scheduler |
| Agent Network | `agent-network.json` stays in place |
| Node database/configuration | Retained in place; the verified enabled Node plugin can resume original saved supervision/return/funding intent |

Before runtime initialization, configuration and encrypted credential files are
copied with private permissions into `core-profile-backups/<core-version>` and
recorded with SHA-256 hashes. Existing backups are verified before reuse. The
process rejects corrupt settings/model-index/wallet JSON, links at protected
configuration paths and unsafe backup entries. No automatic restore is performed.
This is a configuration restore point, not a complete backup of chats/models or
blockchain data. Backup limits fail startup explicitly instead of skipping secrets.

Changing only the app repository cannot change an on-chain address. Keeping the
same encrypted wallet is the identity continuity mechanism. OS keychain behavior
must still be tested in native packaged apps, especially macOS signing ACLs and
Linux Secret Service. A locked keyring may still require unlocking; Core does not
replace it with plaintext or pretend access succeeded.

Plugin migration must be scoped and versioned. A third-party plugin never reads
legacy storage directly. First-party adapters must use reviewed Core services and
preserve the original source until migration is verified. Schema changes that old
versions cannot read require a future profile-version gate. The restored features
use original formats and guarded original migrations, rather than replacing their
stores with generic plugin data. One app at a time prevents races, not schema
incompatibility. See [the parity/lifecycle matrix](PLUGIN_PARITY.md) before changing
which installed features resume in the background.

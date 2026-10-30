# Profile compatibility

Core preserves Electron's runtime name `Koinos AI` and explicitly points both
`userData` and `sessionData` at `<appData>/Koinos AI`. Its installer is `KAI Core`,
app ID `io.koinosai.core`, with updates from `therexdev/kai-core` only.

The default data directory remains `<userData>/core`. `KAI_CORE_DATA` retains the
existing override convention. Core acquires the shared Electron singleton before
reading or backing up that directory. A blocked launch shows an instruction to
fully quit the running Alpha/Test/Core application. Closing Core's main window
quits Core; it does not leave a hidden tray process. Payment disposal settles
in-flight handlers and stops providers before the lock is released.

## Preserved storage

| Data | Handling |
| --- | --- |
| Wallet/address and encrypted session | Existing files and OS credential identity reused; no new wallet generated over an existing one |
| Purchased credits/payment journals | Existing account capability and journals reused; no replay or automatic rollback |
| Model catalog/imported model paths | Existing state and files reused in place |
| Model/runtime/voice downloads | No bulk copy or redownload during adoption |
| Chats/documents | Retained in place for their plugins |
| Brain/workflow/connection data | `companion-hub.json` stays in place; not decrypted or migrated by Core |
| Agent Network | `agent-network.json` stays in place |
| Node database/configuration | Retained; node runtime is not started by Core |

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

Plugin migration must be explicit and versioned. A third-party plugin never reads
legacy storage directly. First-party adapters must use reviewed Core services and
preserve the original source until migration is verified. Schema changes that old
versions cannot read require a future profile-version gate; this preview does not
rewrite the legacy schemas. One app at a time prevents races, not schema incompatibility.

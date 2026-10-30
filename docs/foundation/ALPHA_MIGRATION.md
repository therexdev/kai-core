# Selective Alpha migration

At the bottom of Core Settings, **Migrate from Koinos AI Alpha** opens a review with two independent choices: **Models** and **Wallet**. Close Alpha completely, including its tray process, before copying. No password is requested during migration. Copying is the default. The optional **Delete old models after migration** checkbox removes verified originals within the Alpha models folder after a durable transfer; Alpha wallet and other data remain untouched.

The desktop detects `Koinos AI/core` beneath Electron's operating-system application-data directory, or the headless `~/.koinos-ai` profile. A native folder chooser supports a custom Alpha data directory or its parent `Koinos AI` directory. Source paths are retained privately in the main process; the renderer cannot supply an arbitrary path to the start operation. Current Core profiles and overlapping source/destination directories are rejected.

## What is copied

| Selection | Source | Core destination |
|---|---|---|
| Models | Downloaded GGUF weights and supported projectors in Alpha `models`; existing imported GGUF files referenced by Alpha `state.json` | Core `models`, with canonical catalog names or unique imported model filenames and sanitized metadata |
| Wallet | Alpha `wallet/wallet.json` only | Core `wallet/wallet.json`, only if Core has no wallet or wallet session |

Model copying streams files, verifies hashes and source stability, preserves conflicts, and merges only custom-model records. With cleanup selected, a same-filesystem transfer uses a verified no-overwrite link followed by source removal, avoiding a duplicate payload. Across filesystems, each complete target is verified and flushed before its source is removed; enough free destination space for the next model is still required. Only originals inside the selected Alpha models folder are eligible; external custom-model sources and generated Ollama caches remain untouched. It does not replace Core's state or settings. Generated Ollama caches and runtime binaries are excluded; Core prepares its own runtime from migrated weights. Unsupported or missing files are reported. Existing copied artifacts are recognized on retry. Without cleanup, keep enough free disk space for a separate copy of the selected model files. Cleanup outcomes distinguish moved models, removed originals, retained external originals and cleanup failures. Verified partial transfers survive cancellation and can be retried safely.

The wallet is copied as an encrypted v1 keystore, with its original address, encryption, creation date and compression flag. Historical password hints are omitted from the destination. No source wallet service is instantiated, no private key is decrypted, and no session is imported. Unlocking afterward with the Alpha password verifies the password and derived address. Existing wallet files, including unreadable files, and existing sessions block the wallet selection and are preserved.

Plugin data, documents, connections, accounts, account tokens, credit journals, settings, machine secrets and the Node plugin's separate wallet are never copied. This is a Core-owned, explicit import of two shared resources, not an old-profile compatibility layer.

## Lifecycle and verification

Only one migration can run. The Core-only IPC checks the trusted main window. Model writes/removals are serialized against migration; wallet publication is synchronous under the existing wallet-spend gate and uses exclusive atomic installation. Copies reject linked paths and changed source files. Closing Core to its tray keeps copying; cancellation or Quit cleans temporary files and retains completed copies with a partial result.

`npm test` covers helpers, coordinator and popup state. `npm run test:alpha-migration` launches the real desktop with isolated Alpha/Core profiles, test encrypted wallets and small GGUF fixtures, checks both selections and repeat behavior, captures the actual Settings dialog, and confirms unrelated data and source files remain untouched. This verifies copying and unlock compatibility, not inference quality or live blockchain operations.
